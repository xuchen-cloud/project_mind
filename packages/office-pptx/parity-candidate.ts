import {openPptx,type OpenedPptx} from '@genoffice/pptx-engine';
import {assertZipInflatesWithinLimits} from '@genoffice/zip-gate';
import type {PptxCandidateEdit} from './types';
export const CANDIDATE_MAX_BYTES=100*1024*1024;
export const CANDIDATE_ZIP_LIMITS={maxParts:10000,maxPartBytes:CANDIDATE_MAX_BYTES,maxTotalBytes:256*1024*1024};
export function changedParts(source:OpenedPptx,candidate:OpenedPptx):string[]{
 const parts=new Set([...source.archive.entries.keys(),...candidate.archive.entries.keys()]);
 return [...parts].filter(path=>{const a=source.archive.entries.get(path),b=candidate.archive.entries.get(path);return !a||!b||a.length!==b.length||a.some((v,i)=>v!==b[i])}).sort();
}
export async function candidateEdit(source:OpenedPptx,bytes:Uint8Array):Promise<PptxCandidateEdit>{
 if(bytes.length>CANDIDATE_MAX_BYTES)throw new Error('PPTX candidate exceeds 100 MiB');
 await assertZipInflatesWithinLimits(bytes,CANDIDATE_ZIP_LIMITS);
 const candidate=await openPptx(bytes);
 return {kind:'candidate',sourceHash:source.deck.originalHash,base64:Buffer.from(bytes).toString('base64'),changedParts:changedParts(source,candidate)};
}
