/** Drive the real Excel name box. Pass the loaded renderer document, or its host document. */
export async function selectXlsxRange(doc: Document, range = 'B3:B4'): Promise<void> {
  const frame = doc.querySelector<HTMLIFrameElement>('iframe[title="Excel 完整编辑器"]');
  const renderer = frame ? frame.contentDocument : doc;
  if (!renderer) throw new Error('Excel renderer document is unavailable');
  const inputs = Array.from(renderer.querySelectorAll<HTMLInputElement>('input[type="text"]'))
    .filter(input => input.getClientRects().length > 0 && !input.disabled && !input.readOnly);
  const nameBox = inputs.at(-1);
  if (!nameBox) throw new Error('Excel name box is not ready');
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nameBox), 'value')?.set;
  if (!setValue) throw new Error('Excel name box does not expose a native input value setter');
  const nextFrame = () => new Promise<void>(resolve => renderer.defaultView!.requestAnimationFrame(() => resolve()));
  nameBox.focus();
  setValue.call(nameBox, range);
  nameBox.dispatchEvent(new Event('input', {bubbles: true}));
  // Let React commit the controlled input before its Enter handler reads it.
  await nextFrame();
  nameBox.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true, cancelable: true}));
  nameBox.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true}));
  await nextFrame();
}

/** Evidence from native inspect of the saved simple.original.xlsx fixture. */
export function assertXlsxSaved(model: any): void {
  if (model?.format !== 'xlsx') throw new Error('Saved fixture is not an Excel workbook');
  const cells = model.ranges?.['sheet-1']?.cells;
  if (!Array.isArray(cells)) throw new Error('Saved Excel fixture is missing sheet-1 cells');
  const cell = (row: number, column: number) => cells.find((value: any) => value.row === row && value.column === column);
  if (cell(2, 1)?.value !== 15) throw new Error('Saved Excel B3 must equal 15');
  if (cell(3, 1)?.formula !== '=B3*2') throw new Error('Saved Excel B4 must retain the requested =B3*2 formula');
  if (cell(7, 1)?.value !== 0.125) throw new Error('Unselected Excel B8 percentage value was changed');
  if (cell(8, 1)?.value !== '原样保留\n第二行') throw new Error('Unselected Excel B9 Chinese multiline text was changed');
  if (cell(4, 1)?.formula !== '=SUM(B3:B4)') throw new Error('Unselected Excel B5 total formula was changed');
}
