/** Real metrics for explicitly loaded browser faces; no filesystem discovery. */
import {parse} from 'opentype.js';
import {OpentypeMetrics,type OpentypeFontLike} from '@genoffice/pptx-render';
export interface BrowserFace {family:string;bold:boolean;italic:boolean}
const familyKey=(family:string)=>family.normalize('NFKC').trim().replace(/^['"]|['"]$/g,'').toLowerCase();
const key=(family:string,bold:boolean,italic:boolean)=>`${familyKey(family)}|${Number(bold)}${Number(italic)}`;
export function createBrowserFontMetrics(){
 const fonts=new Map<string,OpentypeFontLike>();
 const provider=new OpentypeMetrics(style=>{
  for(const family of style.fontFamily.split(',')){
   const font=fonts.get(key(family,style.bold,style.italic));if(font)return font;
  }
 });
 const prepare=(face:BrowserFace,data:ArrayBuffer)=>{
  const font=parse(data);
  const measured:OpentypeFontLike={
   unitsPerEm:font.unitsPerEm,ascender:font.ascender,descender:font.descender,
   lineGap:font.tables.hhea?.lineGap??0,
   getAdvanceWidth:(text,size,options)=>font.getAdvanceWidth(text,size,options),
   charToGlyphIndex:char=>font.charToGlyphIndex(char),
  };
  return ()=>fonts.set(key(face.family,face.bold,face.italic),measured);
 };
 return {provider,prepare,register(face:BrowserFace,data:ArrayBuffer){prepare(face,data)()}};
}
