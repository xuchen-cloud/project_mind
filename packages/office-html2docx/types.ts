/** Browser-only, fixed source HTML conversion. No URLs, paths or native capabilities. */
export interface ConvertAltChunkOptions { signal?: AbortSignal }
export declare function convertAltChunkHtml(html: string, options?: ConvertAltChunkOptions): Promise<Uint8Array | null>;
