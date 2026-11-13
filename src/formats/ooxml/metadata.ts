import { findHits, type CompiledRules } from '../../core/matcher';
import { OoxmlPackage } from './package';
import { elementUnit, type Candidate, type TextUnit } from './units';
import { NS, childEls, removeEl } from './xml';

const REL_CORE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const REL_APP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties';
const REL_CUSTOM = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';

/**
 * Property / element names used by classification products. A property with such a name is a label even when its
 * value ("General", "C2", a GUID) matches no keyword.
 *   Microsoft Purview / AIP: MSIP_Label_<guid>_Enabled|SetDate|Method|Name|SiteId|ActionId|ContentBits
 *   Titus: TitusGUID, TitusCorpClassification …   Boldon James: bjDocumentSecurityLabel, bjClsUserRVM …
 */
export const CLASSIFICATION_NAME_RE =
  /^msip_|classif|sensitiv|confidential|securitylabel|protectivemarking|^titus|^bj(document|cls|saver|label)|janusseal|contentmarking/i;

const MSIP_RE = /^MSIP_Label_([0-9a-f-]{36})_(\w+)$/i;

/** Locate a root-level metadata part by relationship type, falling back to the conventional path. */
function rootPart(pkg: OoxmlPackage, relType: string, fallback: string): string | undefined {
  const rel = pkg.rels('').find((r) => r.type === relType && !r.external);
  if (rel && pkg.has(rel.target)) return rel.target;
  return pkg.has(fallback) ? fallback : undefined;
}

const CORE_TEXT: Array<[string, string, string]> = [
  [NS.dc, 'title', '標題'],
  [NS.dc, 'subject', '主旨'],
  [NS.cp, 'keywords', '關鍵字'],
  [NS.dc, 'description', '註解/描述'],
  [NS.cp, 'category', '類別'],
  [NS.cp, 'contentStatus', '內容狀態'],
];

const IDENTITY: Array<[ns: string, local: string, label: string, where: 'core' | 'app']> = [
  [NS.dc, 'creator', '作者', 'core'],
  [NS.cp, 'lastModifiedBy', '上次修改者', 'core'],
  [NS.ep, 'Company', '公司', 'app'],
  [NS.ep, 'Manager', '管理者', 'app'],
];

export interface MetadataScan {
  units: TextUnit[];
  candidates: Candidate[];
}

export function scanMetadata(pkg: OoxmlPackage, compiled: CompiledRules): MetadataScan {
  const units: TextUnit[] = [];
  const candidates: Candidate[] = [];

  // ---- core.xml ------------------------------------------------------------------------------------------------
  const corePath = rootPart(pkg, REL_CORE, 'docProps/core.xml');
  const appPath = rootPart(pkg, REL_APP, 'docProps/app.xml');
  const core = corePath ? pkg.xml(corePath) : undefined;
  const app = appPath ? pkg.xml(appPath) : undefined;

  if (core && corePath) {
    for (const [ns, local, label] of CORE_TEXT) {
      const el = core.getElementsByTagNameNS(ns, local)[0];
      if (!el) continue;
      units.push(markDirtyOnWrite(pkg, corePath, elementUnit(el, { part: corePath, key: local, location: 'property', where: `文件屬性：${label}`, kind: 'metadata' })));
    }
  }

  // ---- identity (author / company) — de-identification even without keyword hits --------------------------------
  for (const [ns, local, label, src] of IDENTITY) {
    const path = src === 'core' ? corePath : appPath;
    const doc = src === 'core' ? core : app;
    const el = doc?.getElementsByTagNameNS(ns, local)[0];
    const value = el?.textContent?.trim();
    if (!el || !path || !value) continue;
    candidates.push({
      finding: {
        id: `${path}#identity:${local}`,
        kind: 'metadata',
        location: 'property',
        matchText: value,
        context: { before: `${label}：`, match: value, after: '' },
        where: `文件屬性：${label}`,
        part: path,
        confidence: 'medium',
        removable: true,
        defaultSelected: true,
        note: '身分資訊（作者 / 公司），去識別化建議清除',
      },
      remove: () => {
        el.textContent = '';
        pkg.markDirty(path);
      },
    });
  }

  // ---- app.xml: everything else that is text (Template, HyperlinkBase, TitlesOfParts …) -----------------------
  if (app && appPath) {
    let i = 0;
    for (const el of Array.from(app.getElementsByTagName('*'))) {
      if (el.firstElementChild || !el.textContent?.trim()) continue;
      if (el.namespaceURI === NS.ep && (el.localName === 'Company' || el.localName === 'Manager')) continue;
      units.push(markDirtyOnWrite(pkg, appPath, elementUnit(el, { part: appPath, key: `e${i++}`, location: 'property', where: `文件屬性：${el.localName}`, kind: 'metadata' })));
    }
  }

  // ---- custom.xml (File → Properties → Custom) ----------------------------------------------------------------
  const customPath = rootPart(pkg, REL_CUSTOM, 'docProps/custom.xml');
  const custom = customPath ? pkg.xml(customPath) : undefined;
  if (custom && customPath) {
    const props = childEls(custom.documentElement, NS.custom, 'property');
    const msip = new Map<string, Element[]>();
    for (const prop of props) {
      const name = prop.getAttribute('name') ?? '';
      const value = prop.textContent ?? '';
      const m = MSIP_RE.exec(name);
      if (m) {
        const g = m[1]!.toLowerCase();
        if (!msip.has(g)) msip.set(g, []);
        msip.get(g)!.push(prop);
        continue;
      }
      const isLabel = CLASSIFICATION_NAME_RE.test(name);
      const hit = findHits(name, compiled).length > 0 || findHits(value, compiled).length > 0;
      if (!isLabel && !hit) continue;
      candidates.push({
        finding: {
          id: `${customPath}#prop:${name}`,
          kind: 'metadata',
          location: isLabel ? 'label' : 'property',
          matchText: `${name} = ${value}`,
          context: { before: '自訂屬性 ', match: `${name} = ${value}`, after: '' },
          where: `自訂屬性：${name}`,
          part: customPath,
          confidence: 'high',
          removable: true,
          defaultSelected: true,
          note: isLabel ? '分級 / 敏感度屬性（屬性名稱即為標籤）' : undefined,
        },
        remove: () => {
          removeEl(prop);
          pkg.markDirty(customPath);
        },
      });
    }
    for (const [guid, group] of msip) {
      const nameProp = group.find((p) => /_Name$/i.test(p.getAttribute('name') ?? ''));
      const labelName = nameProp?.textContent?.trim();
      const text = labelName ? `敏感度標籤「${labelName}」` : `敏感度標籤 ${guid}`;
      candidates.push({
        finding: {
          id: `${customPath}#msip:${guid}`,
          kind: 'metadata',
          location: 'label',
          matchText: text,
          context: { before: 'Microsoft Purview ', match: text, after: `（${group.length} 個 MSIP_Label 屬性）` },
          where: '自訂屬性：MSIP_Label_*',
          part: customPath,
          confidence: 'high',
          removable: true,
          defaultSelected: true,
          note: 'Microsoft Purview / AIP 敏感度標籤 metadata —— DLP 最常見的觸發來源',
        },
        remove: () => {
          group.forEach(removeEl);
          pkg.markDirty(customPath);
        },
      });
    }
  }

  // ---- docMetadata/LabelInfo.xml (new-style Purview label storage) -----------------------------------------------
  for (const path of pkg.paths.filter((p) => /(^|\/)docMetadata\/LabelInfo\.xml$/i.test(p) || (pkg.contentType(p) ?? '').includes('classificationlabels'))) {
    const doc = pkg.xml(path);
    const n = doc ? doc.getElementsByTagName('*').length - 1 : 0;
    candidates.push({
      finding: {
        id: `${path}#part`,
        kind: 'metadata',
        location: 'label',
        matchText: 'LabelInfo.xml',
        context: { before: 'Microsoft Purview ', match: '敏感度標籤資訊', after: `（${Math.max(n, 1)} 個標籤項目）` },
        where: path,
        part: path,
        confidence: 'high',
        removable: true,
        defaultSelected: true,
        note: '新版 Office 儲存敏感度標籤的位置，整個檔案部分將被移除',
      },
      remove: () => pkg.removePart(path),
    });
  }

  // ---- thumbnail: a rendered image of page 1 — shows labels and logos as pixels -----------------------------------
  const thumbRel = pkg.rels('').find((r) => /\/metadata\/thumbnail$/.test(r.type) && !r.external);
  if (thumbRel && pkg.has(thumbRel.target)) {
    const path = thumbRel.target;
    candidates.push({
      finding: {
        id: `${path}#thumbnail`,
        kind: 'image',
        location: 'property',
        matchText: '文件縮圖',
        context: { before: '', match: '文件縮圖', after: '（第一頁的預覽圖片）' },
        where: path,
        part: path,
        confidence: 'high',
        removable: true,
        defaultSelected: true,
        note: '縮圖是第一頁的截圖，可能以圖片形式保留標籤字眼與 Logo，建議移除（Office 下次儲存時會自動重建）',
      },
      remove: () => pkg.removePart(path),
    });
  }

  // ---- customXml/item*.xml (SharePoint properties, content-control data) ----------------------------------------
  for (const path of pkg.paths.filter((p) => /^customXml\/item\d+\.xml$/i.test(p))) {
    let doc: Document | undefined;
    try {
      doc = pkg.xml(path);
    } catch {
      continue;
    }
    if (!doc) continue;
    let i = 0;
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      if (el.firstElementChild) continue;
      const value = el.textContent ?? '';
      const key = `e${i++}`;
      if (CLASSIFICATION_NAME_RE.test(el.localName) && value.trim()) {
        candidates.push({
          finding: {
            id: `${path}#label:${key}`,
            kind: 'metadata',
            location: 'label',
            matchText: `${el.localName} = ${value.trim()}`,
            context: { before: 'SharePoint / 自訂 XML ', match: `${el.localName} = ${value.trim()}`, after: '' },
            where: `自訂 XML：${el.localName}`,
            part: path,
            confidence: 'high',
            removable: true,
            defaultSelected: true,
            note: '分級欄位（欄位名稱即為標籤），值將被清空',
          },
          remove: () => {
            el.textContent = '';
            pkg.markDirty(path);
          },
        });
      } else if (value.trim()) {
        units.push(markDirtyOnWrite(pkg, path, elementUnit(el, { part: path, key, location: 'property', where: `自訂 XML：${el.localName}`, kind: 'metadata' })));
      }
    }
  }

  return { units, candidates };
}

/** Wrap a unit so writing it marks its part dirty. */
export function markDirtyOnWrite(pkg: OoxmlPackage, path: string, unit: TextUnit): TextUnit {
  const prev = unit.afterWrite;
  return {
    ...unit,
    afterWrite: (changed) => {
      if (changed.length) pkg.markDirty(path);
      prev?.(changed);
    },
  };
}
