import {openPptx,type OpenedPptx} from '@genoffice/pptx-engine';
/** Compare uncompressed package parts, independent of ZIP timestamps/order. */
export function sameArchive(a:OpenedPptx,b:OpenedPptx):boolean {
 if(a.archive.entries.size!==b.archive.entries.size)return false;
 for(const [path,bytes] of a.archive.entries){const other=b.archive.entries.get(path);if(!other||bytes.length!==other.length||bytes.some((v,i)=>v!==other[i]))return false}
 return true;
}
export async function samePackage(bytes:Uint8Array,base64:string):Promise<boolean>{return sameArchive(await openPptx(bytes),await openPptx(new Uint8Array(Buffer.from(base64,'base64'))))}
