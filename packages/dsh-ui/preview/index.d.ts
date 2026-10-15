import type { ReactElement } from 'react';
export type DshPreviewKind = 'text' | 'code' | 'markdown' | 'image' | 'pdf' | 'html';
export function DshFilePreview(props: {kind:DshPreviewKind;name:string;text?:string;bytes?:Uint8Array;line?:number;page?:number;signal:AbortSignal;resources?:Record<string,string>;initialView?:{page?:number;scrollTop?:number;zoom?:number};onViewChange?:(view:{line?:number;page?:number;scrollTop?:number;zoom?:number})=>void}): ReactElement;
