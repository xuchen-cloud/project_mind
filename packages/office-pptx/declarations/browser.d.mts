import type { PptxModel, PptxEdit, PptxRenderSlide } from '../types';
import type { ReactElement } from 'react';
export declare function previewSlides(model: PptxModel, edits: PptxEdit[]): PptxRenderSlide[];
export declare function ReactSvgSlide(props: { slide: PptxRenderSlide; label: string; onSelect?: (id: string) => void; selectedId?: string }): ReactElement;
