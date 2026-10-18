import type {PptxEdit} from './types';

// Host OfficeEditSession snapshots clone these JSON DTOs. Compare their values
// without serializing another copy of the potentially large package candidate.
function sameValue(a:unknown,b:unknown):boolean {
 if(a===b)return true;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((value,index)=>sameValue(value,b[index]));
 const left=a as Record<string,unknown>,right=b as Record<string,unknown>,keys=Object.keys(left);
 return keys.length===Object.keys(right).length&&keys.every(key=>Object.prototype.hasOwnProperty.call(right,key)&&sameValue(left[key],right[key]));
}
export function samePptxEdits(a:PptxEdit[],b:PptxEdit[]):boolean {return sameValue(a,b)}
