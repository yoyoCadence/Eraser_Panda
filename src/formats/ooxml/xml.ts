/** Namespace URIs used across OOXML parts (Transitional conformance). */
export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  ep: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  custom: 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  vt: 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  xml: 'http://www.w3.org/XML/1998/namespace',
  tc: 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments',
} as const;

export function parseXml(text: string, path: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement) {
    throw new Error(`XML 解析失敗：${path}`);
  }
  return doc;
}

const DECL_RE = /^﻿?\s*(<\?xml[^>]*\?>)/;

/** Serialize, keeping the original XML declaration (XMLSerializer drops it; Office expects it). */
export function serializeXml(doc: Document, originalText: string): string {
  const body = new XMLSerializer().serializeToString(doc).replace(DECL_RE, '');
  const decl = DECL_RE.exec(originalText)?.[1] ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return `${decl}\r\n${body}`;
}

/** Elements in document order (live HTMLCollection → array snapshot). */
export function els(root: Document | Element, ns: string, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS(ns, local));
}

export function firstChildEl(parent: Element, ns: string, local: string): Element | null {
  for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
    if (c.namespaceURI === ns && c.localName === local) return c;
  }
  return null;
}

export function childEls(parent: Element, ns?: string, local?: string): Element[] {
  const out: Element[] = [];
  for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
    if ((ns === undefined || c.namespaceURI === ns) && (local === undefined || c.localName === local)) out.push(c);
  }
  return out;
}

/** Nearest ancestor (excluding self) with the given namespace + local name. */
export function closest(el: Element, ns: string, local: string): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.namespaceURI === ns && p.localName === local) return p;
  }
  return null;
}

export function hasAncestor(el: Element, ns: string, local: string): boolean {
  return closest(el, ns, local) !== null;
}

export function removeEl(el: Element): void {
  el.parentNode?.removeChild(el);
}
