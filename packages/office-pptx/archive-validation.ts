/** Complete XML admission is independent of which slides the view has parsed. */
import {XMLValidator} from 'fast-xml-parser';
import {validateXmlCharacters} from './validate';
export function validateArchiveXml(entries:ReadonlyMap<string,Uint8Array>):void{
 const decoder=new TextDecoder('utf-8',{fatal:true});
 for(const [path,bytes] of entries){
  if(!/\.(?:xml|rels)$/.test(path))continue;
  let xml:string;
  try{xml=decoder.decode(bytes)}catch{throw Error(`Invalid UTF-8 XML part: ${path}`)}
  validateXmlCharacters(xml);
  const encoding=/<\?xml\b[^>]*\bencoding=["']([^"']+)["']/.exec(xml)?.[1];
  if(encoding&&!/^utf-8$/i.test(encoding))throw Error(`Unsupported XML encoding ${encoding}: ${path}`);
  const valid=XMLValidator.validate(xml);
  if(valid!==true)throw Error(`Invalid XML part ${path}: ${valid.err.msg}`);
 }
}
