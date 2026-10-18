/** Register the live upstream App handlers without creating another editor/session. */
import {useLayoutEffect, useRef} from 'react';
export type PptxOutputCommand = 'pdf' | 'images' | 'print';
type Handlers = Record<PptxOutputCommand, () => unknown | Promise<unknown>>;
let current: {run: (command: PptxOutputCommand) => unknown | Promise<unknown>} | undefined;
export function usePptxOutput(handlers: Handlers) {
 const latest = useRef(handlers); latest.current = handlers;
 useLayoutEffect(() => {
  const registration = {run: (command: PptxOutputCommand) => latest.current[command]()};
  current = registration;
  return () => {if (current === registration) current = undefined};
 }, []);
}
export async function runPptxOutput(command: PptxOutputCommand) {
 if (!current) throw new Error('PPTX 编辑器尚未就绪');
 await current.run(command);
}
