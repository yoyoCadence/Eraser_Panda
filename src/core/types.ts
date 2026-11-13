/**
 * Shared, format-agnostic model.
 *
 * Every format handler (OOXML, PDF, plain text) produces `Finding`s during `scan()` and consumes a set of
 * finding ids during `apply()`. Finding ids MUST be stable: the same input bytes + the same rules always yield
 * the same ids, because `apply()` re-scans the original file and removes exactly the findings whose ids were
 * selected by the user.
 */

export type FormatId = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'text';

/** What was found. */
export type FindingKind =
  | 'text' //        a keyword hit inside document text
  | 'metadata' //    a document property / sensitivity label / XMP entry
  | 'image' //       a logo candidate
  | 'watermark' //   a whole watermark object (Word VML watermark, PDF watermark artifact)
  | 'annotation'; // a PDF annotation (e.g. "Confidential" stamp) or Office comment

/** Where it was found — drives grouping in the UI and the "body text may change meaning" warning. */
export type LocationKind =
  | 'body'
  | 'header'
  | 'footer'
  | 'watermark'
  | 'textbox'
  | 'comment'
  | 'notes'
  | 'master' //      slide master / layout
  | 'chart'
  | 'formula'
  | 'sheetName'
  | 'property' //    core/app/custom properties, XMP, PDF Info
  | 'label' //       Microsoft Purview / MSIP sensitivity label
  | 'annotation'
  | 'bookmark'
  | 'formField'
  | 'other';

export type Confidence = 'high' | 'medium' | 'low';

/** Axis-aligned rectangle in page space, normalised to 0..1 (origin top-left), used for preview highlights. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Finding {
  /** Stable id, unique within one file. Encodes the location, e.g. `word/header1.xml#p3:12-24`. */
  id: string;
  kind: FindingKind;
  location: LocationKind;
  /** Rule that produced the hit (text/metadata findings). */
  ruleId?: string;
  /** The exact original text that would be removed (for images: a short description). */
  matchText: string;
  /** Surrounding text for the preview list. */
  context?: { before: string; match: string; after: string };
  /** Human-readable location, e.g. "第 3 頁", "頁首 (header1.xml)", "Sheet1!B4", "自訂屬性 Classification". */
  where: string;
  /** 1-based page / slide / sheet index when meaningful. */
  page?: number;
  /** Internal container path (zip part, PDF object ref). */
  part?: string;
  /** Highlight boxes on `page`. */
  rects?: NormRect[];
  /** Data URL thumbnail (images). */
  thumbnail?: string;
  confidence: Confidence;
  /** false → report only, the tool cannot safely remove it (e.g. Excel sheet names referenced by formulas). */
  removable: boolean;
  /** Pre-checked in the UI. */
  defaultSelected: boolean;
  /** Extra explanation shown to the user. */
  note?: string;
}

export interface ScanResult {
  format: FormatId;
  findings: Finding[];
  /** Non-fatal problems the user should know about. */
  warnings: string[];
  /** Number of pages / slides / sheets, when known. */
  pageCount?: number;
}

export interface Rule {
  id: string;
  /** Literal text or a regular expression source. */
  pattern: string;
  isRegex: boolean;
  /** Only match at word boundaries (ignored for CJK-only patterns, which have no word boundaries). */
  wholeWord: boolean;
  caseSensitive: boolean;
  enabled: boolean;
  category: 'label' | 'company' | 'custom';
}

export interface FormatHandler {
  id: FormatId;
  scan(input: Uint8Array, ctx: ScanContext): Promise<ScanResult>;
  /** Produce a NEW file with the selected findings removed. Never mutates `input`. */
  apply(input: Uint8Array, ctx: ScanContext, removeIds: ReadonlySet<string>): Promise<Uint8Array>;
}

/** Everything a handler needs besides the bytes. Kept as an object so later milestones can extend it. */
export interface ScanContext {
  rules: Rule[];
  /** Perceptual hashes (core/image.ts `logoHash`) of user-supplied logo samples. */
  logoHashes?: string[];
  /** Decoder for encoded images (JPEG …) — provided by the browser; PNG and raw PDF images are decoded in-engine. */
  decodeImage?: import('./image').ImageDecoder;
}

/** Thrown for problems the user can act on; `message` is shown verbatim in the UI. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}
