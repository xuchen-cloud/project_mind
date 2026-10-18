/** One iframe's non-secret File context, shared by async upstream action adapters. */
let epoch=0;
export const currentPptxEpoch=()=>epoch;
export function setPptxEpoch(value:number){epoch=value}
export function assertPptxEpoch(value:number){if(value!==epoch)throw new Error('PPTX 编辑内容已替换')}
