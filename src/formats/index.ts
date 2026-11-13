import type { FormatHandler, FormatId } from '../core/types';
import { docxHandler, pptxHandler, xlsxHandler } from './ooxml/handler';
import { textHandler } from './text/handler';

const HANDLERS: Partial<Record<FormatId, FormatHandler>> = {
  docx: docxHandler,
  xlsx: xlsxHandler,
  pptx: pptxHandler,
  text: textHandler,
};

export function handlerFor(format: FormatId): FormatHandler | undefined {
  return HANDLERS[format];
}
