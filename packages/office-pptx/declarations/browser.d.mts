import type { PptxModel, PptxEdit, PptxRenderSlide, PptxTextElement } from '../types';
import type { ReactElement } from 'react';
export declare function previewSlides(model: PptxModel, edits: PptxEdit[]): PptxRenderSlide[];
export declare function ReactSvgSlide(props: { slide: PptxRenderSlide; label: string; onSelect?: (id: string) => void; selectedId?: string; textTarget?: PptxTextElement; edits?: PptxEdit[]; readOnly?: boolean; onTextChange?: (paragraphIndex: number, runIndex: number, text: string) => void }): ReactElement;
