import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { NS, childEls, parseXml, serializeXml } from './xml';

export interface Relationship {
  id: string;
  type: string;
  /** Resolved absolute part path without leading slash, or the raw target for external relationships. */
  target: string;
  external: boolean;
}

/** Fixed zip timestamp → byte-identical output for identical input (reproducible, testable). */
const ZIP_MTIME = new Date('2000-01-01T00:00:00Z');

/**
 * An OOXML package (docx / xlsx / pptx) loaded in memory.
 *
 * Parts are parsed lazily. Only parts that were explicitly marked dirty are re-serialised on save; every other part
 * keeps its original bytes, so a de-identified file differs from the original only where something was removed.
 */
export class OoxmlPackage {
  private readonly files: Map<string, Uint8Array>;
  private readonly docs = new Map<string, { doc: Document; text: string }>();
  private readonly dirty = new Set<string>();
  private contentTypes?: { overrides: Map<string, string>; defaults: Map<string, string> };

  constructor(bytes: Uint8Array) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error('檔案已損毀或不是有效的 Office 文件（ZIP 解壓失敗）。');
    }
    this.files = new Map(Object.entries(entries));
  }

  get paths(): string[] {
    return [...this.files.keys()];
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  bytes(path: string): Uint8Array | undefined {
    return this.files.get(path);
  }

  text(path: string): string | undefined {
    const b = this.files.get(path);
    return b ? strFromU8(b) : undefined;
  }

  xml(path: string): Document | undefined {
    const cached = this.docs.get(path);
    if (cached) return cached.doc;
    const text = this.text(path);
    if (text === undefined) return undefined;
    const doc = parseXml(text, path);
    this.docs.set(path, { doc, text });
    return doc;
  }

  /** Replace a binary part (e.g. a cleaned embedded workbook). */
  setBytes(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
    this.docs.delete(path);
    this.dirty.delete(path);
  }

  markDirty(path: string): void {
    if (!this.docs.has(path)) throw new Error(`markDirty on unparsed part ${path}`);
    this.dirty.add(path);
  }

  /** Content type of a part, from [Content_Types].xml (Override first, then Default by extension). */
  contentType(path: string): string | undefined {
    const ct = this.loadContentTypes();
    const o = ct.overrides.get(path.toLowerCase());
    if (o) return o;
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    return ct.defaults.get(ext);
  }

  private loadContentTypes() {
    if (this.contentTypes) return this.contentTypes;
    const overrides = new Map<string, string>();
    const defaults = new Map<string, string>();
    const doc = this.xml('[Content_Types].xml');
    if (doc) {
      for (const el of childEls(doc.documentElement, NS.ct, 'Override')) {
        overrides.set((el.getAttribute('PartName') ?? '').replace(/^\//, '').toLowerCase(), el.getAttribute('ContentType') ?? '');
      }
      for (const el of childEls(doc.documentElement, NS.ct, 'Default')) {
        defaults.set((el.getAttribute('Extension') ?? '').toLowerCase(), el.getAttribute('ContentType') ?? '');
      }
    }
    this.contentTypes = { overrides, defaults };
    return this.contentTypes;
  }

  /** Paths of all parts whose content type contains `fragment`, in zip order. */
  partsByType(fragment: string): string[] {
    return this.paths.filter((p) => !p.endsWith('/') && (this.contentType(p) ?? '').includes(fragment));
  }

  static relsPathFor(part: string): string {
    const i = part.lastIndexOf('/');
    return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
  }

  /** Relationships of a part ('' = package root). */
  rels(part: string): Relationship[] {
    const relsPath = part === '' ? '_rels/.rels' : OoxmlPackage.relsPathFor(part);
    const doc = this.xml(relsPath);
    if (!doc) return [];
    const baseDir = part.includes('/') ? part.slice(0, part.lastIndexOf('/') + 1) : '';
    return childEls(doc.documentElement, NS.rel, 'Relationship').map((el) => {
      const raw = el.getAttribute('Target') ?? '';
      const external = el.getAttribute('TargetMode') === 'External';
      return {
        id: el.getAttribute('Id') ?? '',
        type: el.getAttribute('Type') ?? '',
        target: external ? raw : resolvePath(baseDir, raw),
        external,
      };
    });
  }

  relTarget(part: string, rId: string): string | undefined {
    return this.rels(part).find((r) => r.id === rId && !r.external)?.target;
  }

  /** Remove a relationship by id from a part's .rels. */
  removeRel(part: string, rId: string): void {
    const relsPath = part === '' ? '_rels/.rels' : OoxmlPackage.relsPathFor(part);
    const doc = this.xml(relsPath);
    if (!doc) return;
    for (const el of childEls(doc.documentElement, NS.rel, 'Relationship')) {
      if (el.getAttribute('Id') === rId) {
        el.parentNode!.removeChild(el);
        this.markDirty(relsPath);
      }
    }
  }

  /**
   * Delete a part and everything that points at it: relationships in any .rels file, its content-type Override,
   * and its own .rels file. Callers must remove XML references by r:id themselves (they know the vocabulary).
   */
  removePart(path: string): void {
    if (!this.files.has(path)) return;
    this.files.delete(path);
    this.docs.delete(path);
    this.dirty.delete(path);
    const ownRels = OoxmlPackage.relsPathFor(path);
    if (this.files.has(ownRels)) {
      this.files.delete(ownRels);
      this.docs.delete(ownRels);
      this.dirty.delete(ownRels);
    }
    for (const relsPath of this.paths.filter((p) => p.endsWith('.rels'))) {
      const source = sourceOfRels(relsPath);
      for (const r of this.rels(source)) {
        if (!r.external && r.target === path) this.removeRel(source, r.id);
      }
    }
    const ct = this.xml('[Content_Types].xml');
    if (ct) {
      for (const el of childEls(ct.documentElement, NS.ct, 'Override')) {
        if ((el.getAttribute('PartName') ?? '').replace(/^\//, '').toLowerCase() === path.toLowerCase()) {
          el.parentNode!.removeChild(el);
          this.markDirty('[Content_Types].xml');
        }
      }
    }
    this.contentTypes = undefined;
  }

  /** Is any relationship (from any part) still pointing at `path`? */
  isReferenced(path: string): boolean {
    for (const relsPath of this.paths.filter((p) => p.endsWith('.rels'))) {
      if (this.rels(sourceOfRels(relsPath)).some((r) => !r.external && r.target === path)) return true;
    }
    return false;
  }

  save(): Uint8Array {
    const out: Zippable = {};
    for (const [path, data] of this.files) {
      let bytes = data;
      if (this.dirty.has(path)) {
        const { doc, text } = this.docs.get(path)!;
        bytes = strToU8(serializeXml(doc, text));
      }
      const alreadyCompressed = /\.(png|jpe?g|gif|wdp|jxr|mp4|m4a|mp3|zip)$/i.test(path);
      out[path] = [bytes, { level: alreadyCompressed ? 0 : 6, mtime: ZIP_MTIME }];
    }
    return zipSync(out);
  }
}

/** Source part of a .rels file: `word/_rels/document.xml.rels` → `word/document.xml`, `_rels/.rels` → ''. */
export function sourceOfRels(relsPath: string): string {
  if (relsPath === '_rels/.rels') return '';
  const m = /^(.*?)_rels\/(.+)\.rels$/.exec(relsPath);
  return m ? `${m[1]}${m[2]}` : '';
}

/** Resolve a relationship target against the source part's directory. */
export function resolvePath(baseDir: string, target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : baseDir + target;
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return decodeURIComponentSafe(out.join('/'));
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
