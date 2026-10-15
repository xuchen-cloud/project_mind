import type { PptxModel, PptxEdit } from '../types';
export declare function inspect(bytes: Uint8Array): Promise<PptxModel>;
export declare function edit(bytes: Uint8Array, edits: PptxEdit[]): Promise<Uint8Array>;
