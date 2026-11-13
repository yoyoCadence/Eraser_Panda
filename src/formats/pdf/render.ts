/**
 * pdf.js wrapper used ONLY for on-screen previews (rendering pages to canvas).
 * All detection and removal happens in our own engine on top of pdf-lib; pdf.js never decides what is removed.
 *
 * The worker source is inlined into the single HTML file and started from a blob: URL, because a page opened via
 * file:// cannot load a separate worker file, and the CSP forbids any network access.
 */
import * as pdfjs from 'pdfjs-dist';
import workerCode from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';

let ready = false;

function setup(): void {
  if (ready) return;
  ready = true;
  const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
  pdfjs.GlobalWorkerOptions.workerSrc = url;
}

export type PdfJsDoc = pdfjs.PDFDocumentProxy;

export interface OpenedPdf {
  doc: PdfJsDoc;
  /** Tear down the loading task and its worker-side document. */
  destroy: () => Promise<void>;
}

export async function openForPreview(bytes: Uint8Array): Promise<OpenedPdf> {
  setup();
  const task = pdfjs.getDocument({
    data: bytes.slice(), // pdf.js transfers the buffer to its worker — never hand it the original
    useSystemFonts: true,
    useWasm: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  return { doc, destroy: () => task.destroy() };
}

/** Render one page into a canvas at a CSS width; returns the canvas and page size in PDF points. */
export async function renderPage(doc: PdfJsDoc, pageNo: number, cssWidth: number): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const scale = (cssWidth / base.width) * dpr;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(cssWidth * base.height) / base.width}px`;
  await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
  page.cleanup();
  return { canvas, width: base.width, height: base.height };
}
