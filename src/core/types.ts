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
  | 'annotation' // a PDF annotation (e.g. "Confidential" stamp) or Office comment
  | 'region'; //     everything inside a rectangle the user drew on the preview (PDF)

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
  | 'region' //      user-drawn removal region
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
  /**
   * Highlight boxes on EVERY page the finding affects (including `page`) — e.g. a logo or header that is one shared
   * object drawn on 80 pages. When present, previews use this instead of `page` + `rects`.
   */
  highlights?: Array<{ page: number; rects: NormRect[] }>;
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
  /** Structured text preview (Office / text formats; PDF is previewed visually). */
  preview?: PreviewBlock[];
  /** What each user-drawn region (ScanContext.regions) contains, by region id (PDF). */
  regionStats?: Record<string, RegionStats>;
}

/**
 * A rectangle the user drew on the PDF preview: remove everything inside it on pages `from`..`to`.
 * The rectangle is normalised to the page AS DISPLAYED (0..1, origin top-left), so "the same place" means the same
 * relative position on every page of the range.
 */
export interface Region {
  /** Stable id assigned by the UI (finding id = `region:<id>`). */
  id: string;
  rect: NormRect;
  /** 1-based first page */
  from: number;
  /** 1-based last page (inclusive) */
  to: number;
}

export interface RegionStats {
  /** removable glyphs (characters) */
  text: number;
  images: number;
  /** vector graphics (paths) */
  paths: number;
  annots: number;
  /** objects only partly inside the region (left alone — an image cannot be cut in half) */
  partial: number;
  /** objects inside the region that are shared with pages / positions outside it (left alone) */
  shared: number;
  /** pages of the range that exist in the document */
  pages: number;
  /** a few characters of the text found inside (UI only, never written to reports) */
  sample: string;
}

/** One section of the structured preview: a slide, a header, a sheet, the body … */
export interface PreviewBlock {
  title: string;
  page?: number;
  lines: PreviewLine[];
}

export interface PreviewLine {
  text: string;
  /** highlighted ranges, each tied to a finding */
  marks: Array<{ start: number; end: number; id: string }>;
  /** location badge, e.g. 頁首 / 浮水印 / 註解 */
  tag?: string;
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
  /** Original file name (format-specific decisions, e.g. CSV vs. prose text). */
  fileName?: string;
  /** Perceptual hashes (core/image.ts `logoHash`) of user-supplied logo samples. */
  logoHashes?: string[];
  /** Decoder for encoded images (JPEG …) — provided by the browser; PNG and raw PDF images are decoded in-engine. */
  decodeImage?: import('./image').ImageDecoder;
  /** User-drawn removal regions for THIS file (PDF only). */
  regions?: Region[];
}

/** Thrown for problems the user can act on; `message` is shown verbatim in the UI. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}
