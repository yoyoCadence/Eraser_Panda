import { PDFName, type PDFDocument } from 'pdf-lib';
import type { Candidate, TextUnit } from '../../core/candidates';
import { findHits, type CompiledRules } from '../../core/matcher';
import { CLASSIFICATION_NAME_RE } from '../ooxml/metadata';
import { infoDict, pdfText, streamBytes, toPdfString } from './pdfdoc';

const INFO_LABEL: Record<string, string> = {
  Title: '標題',
  Subject: '主旨',
  Keywords: '關鍵字',
  Author: '作者',
  Creator: '建立程式',
  Producer: '產生程式',
};
const IDENTITY_KEYS = new Set(['Author', 'Company', 'Manager', 'LastModifiedBy', 'Last Modified By']);
const MSIP_RE = /^MSIP_Label_([0-9a-f-]{36})_(\w+)$/i;

export function scanPdfMetadata(doc: PDFDocument, compiled: CompiledRules): { units: TextUnit[]; candidates: Candidate[] } {
  const units: TextUnit[] = [];
  const candidates: Candidate[] = [];

  // ---- document information dictionary --------------------------------------------------------------------------
  const info = infoDict(doc);
  if (info) {
    const msip = new Map<string, PDFName[]>();
    const msipName = new Map<string, string>();
    for (const [k, v] of info.entries()) {
      const key = k.decodeText();
      const value = pdfText(info.lookup(k)) ?? '';
      const m = MSIP_RE.exec(key);
      if (m) {
        const g = m[1]!.toLowerCase();
        msip.set(g, [...(msip.get(g) ?? []), k]);
        if (/^name$/i.test(m[2]!)) msipName.set(g, value);
        continue;
      }
      if (IDENTITY_KEYS.has(key) && value.trim()) {
        candidates.push({
          finding: {
            id: `info#identity:${key}`,
            kind: 'metadata',
            location: 'property',
            matchText: value,
            context: { before: `${INFO_LABEL[key] ?? key}：`, match: value, after: '' },
            where: `文件屬性：${INFO_LABEL[key] ?? key}`,
            confidence: 'medium',
            removable: true,
            defaultSelected: true,
            note: '身分資訊（作者 / 公司），去識別化建議清除',
          },
          remove: () => info.delete(k),
        });
        continue;
      }
      const isLabel = CLASSIFICATION_NAME_RE.test(key);
      if (isLabel || findHits(key, compiled).length) {
        candidates.push({
          finding: {
            id: `info#key:${key}`,
            kind: 'metadata',
            location: isLabel ? 'label' : 'property',
            matchText: `${key} = ${value}`,
            context: { before: '自訂屬性 ', match: `${key} = ${value}`, after: '' },
            where: `文件屬性：${key}`,
            confidence: 'high',
            removable: true,
            defaultSelected: true,
            note: isLabel ? '分級 / 敏感度屬性（屬性名稱即為標籤）' : undefined,
          },
          remove: () => info.delete(k),
        });
        continue;
      }
      if (!value) continue;
      units.push({
        part: 'info',
        key,
        location: 'property',
        kind: 'metadata',
        where: `文件屬性：${INFO_LABEL[key] ?? key}`,
        segments: [{ text: value }],
        refs: [null],
        write: ([t]) => {
          if (t!.trim()) info.set(k, toPdfString(t!));
          else info.delete(k);
        },
      });
    }
    for (const [guid, keys] of msip) {
      const label = msipName.get(guid);
      const text = label ? `敏感度標籤「${label}」` : `敏感度標籤 ${guid}`;
      candidates.push({
        finding: {
          id: `info#msip:${guid}`,
          kind: 'metadata',
          location: 'label',
          matchText: text,
          context: { before: 'Microsoft Purview ', match: text, after: `（${keys.length} 個 MSIP_Label 屬性）` },
          where: '文件屬性：MSIP_Label_*',
          confidence: 'high',
          removable: true,
          defaultSelected: true,
          note: 'Office 匯出 PDF 時帶入的 Purview / AIP 敏感度標籤 —— DLP 最常見的觸發來源',
        },
        remove: () => keys.forEach((k) => info.delete(k)),
      });
    }
  }

  // ---- XMP metadata stream (Catalog /Metadata) ------------------------------------------------------------------
  const metaRef = doc.catalog.get(PDFName.of('Metadata'));
  const xmpBytes = metaRef ? streamBytes(doc.catalog.lookup(PDFName.of('Metadata'))) : undefined;
  if (metaRef && xmpBytes) {
    const xmp = new TextDecoder().decode(xmpBytes);
    const reasons: string[] = [];
    if (/MSIP_Label_/i.test(xmp)) reasons.push('敏感度標籤');
    const textOnly = xmp.replace(/<[^>]*>/g, ' ');
    const hits = findHits(textOnly, compiled);
    if (hits.length) reasons.push(`${hits.length} 個字眼（${[...new Set(hits.map((h) => h.text))].slice(0, 3).join('、')}）`);
    if (/<dc:creator\b[\s\S]*?<rdf:li[^>]*>\s*[^<\s]/.test(xmp) || /<pdf:Author>\s*[^<\s]/.test(xmp)) reasons.push('作者');
    if (/(classification|sensitivity)/i.test(xmp.replace(/xmlns:[^=]+="[^"]*"/g, ''))) reasons.push('分級欄位');
    if (reasons.length) {
      candidates.push({
        finding: {
          id: 'catalog#xmp',
          kind: 'metadata',
          location: /MSIP_Label_|classification|sensitivity/i.test(xmp) ? 'label' : 'property',
          matchText: 'XMP metadata',
          context: { before: 'XMP metadata 含：', match: reasons.join('、'), after: '' },
          where: '文件 XMP metadata',
          confidence: 'high',
          removable: true,
          defaultSelected: true,
          note: '整段 XMP metadata 將被移除（文件資訊字典仍保留，若此 PDF 宣告符合 PDF/A，該宣告會失效）',
        },
        remove: () => doc.catalog.delete(PDFName.of('Metadata')),
      });
    }
  }

  // ---- PieceInfo: application private data (Illustrator / Acrobat) can embed whole source documents ---------------
  if (doc.catalog.get(PDFName.of('PieceInfo'))) {
    candidates.push({
      finding: {
        id: 'catalog#pieceinfo',
        kind: 'metadata',
        location: 'property',
        matchText: 'PieceInfo',
        context: { before: '', match: '應用程式私有資料（PieceInfo）', after: '' },
        where: '文件目錄',
        confidence: 'medium',
        removable: true,
        defaultSelected: true,
        note: '編輯軟體的私有資料，可能夾帶原始檔內容；移除不影響顯示',
      },
      remove: () => doc.catalog.delete(PDFName.of('PieceInfo')),
    });
  }

  return { units, candidates };
}
