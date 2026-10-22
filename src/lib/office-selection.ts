export type OfficeSelectionFormat = 'docx' | 'xlsx' | 'pptx';
export interface OfficeSelectionController {
  captureSelection(): Promise<{selectionId: string; text: string}>;
  applySelection(input: {selectionId: string; change: unknown}): Promise<{text: string}>;
}

/** Native error budgets count UTF-8 bytes, not UTF-16 code units. */
export function officeSelectionError(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  const encoder = new TextEncoder();
  let result = '', bytes = 0;
  for (const character of text) {
    bytes += encoder.encode(character).length;
    if (bytes > 4096) break;
    result += character;
  }
  return result;
}
