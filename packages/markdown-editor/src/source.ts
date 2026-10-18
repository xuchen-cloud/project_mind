import { diffChars } from 'diff';
export interface SourceEdit {from:number;to:number;insert:string}
export const normalizedSource=(source:string)=>source.replace(/\r\n|\r/g,'\n');
/** Map editor coordinates to the untouched original, retaining mixed line endings and BOM. */
export function rawOffset(source:string,offset:number):number {
  let raw=0;let logical=0;
  while(raw<source.length && logical<offset){ if(source[raw]==='\r'&&source[raw+1]==='\n')raw++;raw++;logical++; }
  return raw;
}
export function applySourceEdits(source:string,edits:readonly SourceEdit[]):string {
  const eol=source.match(/\r\n|\r|\n/)?.[0]??'\n';
  let result=source;
  for(const edit of [...edits].sort((a,b)=>b.from-a.from)) {
    const from=rawOffset(source,edit.from),to=rawOffset(source,edit.to);
    result=result.slice(0,from)+edit.insert.replace(/\r\n|\r|\n/g,eol)+result.slice(to);
  }
  return result;
}
/** Splice serializer changes while preserving every unchanged run's original line endings. */
export function mergeRenderedSource(original:string,next:string):string {
  const before=normalizedSource(original),after=normalizedSource(next);
  if(before===after)return original;
  const edits:SourceEdit[]=[];
  let offset=0;
  for(const part of diffChars(before,after)){
    if(part.added){const previous=edits[edits.length-1];if(previous&&previous.to===offset)previous.insert+=part.value;else edits.push({from:offset,to:offset,insert:part.value});}
    else if(part.removed){const previous=edits[edits.length-1];if(previous&&previous.to===offset)previous.to+=part.value.length;else edits.push({from:offset,to:offset+part.value.length,insert:''});offset+=part.value.length;}
    else offset+=part.value.length;
  }
  return applySourceEdits(original,edits);
}
