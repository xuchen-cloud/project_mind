import type { ConvertAltChunkOptions } from '../types';
import { convertHtmlToDocx, raceWithAbort } from '../upstream/packages/html2docx/src/convert';
import { IframeDriver } from './driver';
import { MAX_BYTES } from './sanitize';

export async function convertAltChunkHtml(html: string, options: ConvertAltChunkOptions = {}): Promise<Uint8Array | null> {
  if (typeof html !== 'string') throw new TypeError('altChunk HTML must be a string');
  if (html.length>MAX_BYTES || new TextEncoder().encode(html).length>MAX_BYTES) throw new Error('altChunk HTML exceeds 64 MiB');
  const {signal} = options;
  if (signal?.aborted) throw new DOMException('altChunk conversion aborted','AbortError');
  const driver = new IframeDriver(html,signal);
  const cancel = () => {void driver.close();};
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    const result = await raceWithAbort(convertHtmlToDocx({url:'about:srcdoc'},driver,{signal,naturalTableWidth:true}),signal);
    // Upstream logs and continues after screenshot errors. This boundary must fail visibly.
    if (driver.failure) throw driver.failure;
    if (driver.empty) return null;
    if (!result.docx.length || result.docx.length>MAX_BYTES) throw new Error('altChunk DOCX exceeds 64 MiB or is empty');
    return result.docx;
  } finally { signal?.removeEventListener('abort',cancel);await driver.close(); }
}
