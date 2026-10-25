/** Land generated chart caches as an embedded workbook so PowerPoint's Edit Data is available. */
import JSZip from 'jszip';
import {XMLParser} from 'fast-xml-parser';
const MAIN='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/package/2006/relationships';
const DOCREL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml=(v:unknown)=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',removeNSPrefix:true,parseTagValue:false});
const array=(v:any)=>v===undefined?[]:Array.isArray(v)?v:[v];
function colNumber(s:string){return [...s].reduce((a,c)=>a*26+c.charCodeAt(0)-64,0)}
function colName(n:number){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}

async function cachedWorkbook(chart:string):Promise<Uint8Array|null>{
 const cells=new Map<string,{value:string;numeric:boolean}>();
 const add=(ref:any,numeric:boolean)=>{
  const formula=ref.f;
  if(typeof formula!=='string')return;
  const match=/^Sheet1!\$([A-Z]+)\$(\d+)(?::\$([A-Z]+)\$(\d+))?$/.exec(formula);
  if(!match)throw new Error(`Unsupported generated chart data range ${formula}`);
  const firstCol=colNumber(match[1]),firstRow=Number(match[2]),lastCol=match[3]?colNumber(match[3]):firstCol,lastRow=match[4]?Number(match[4]):firstRow;
  if(firstCol<1||lastCol>16384||firstRow<1||lastRow>1048576||lastCol!==firstCol||lastRow<firstRow||lastRow-firstRow>100000)throw new Error('Generated chart data range exceeds workbook budget');
  const cache=ref[numeric?'numCache':'strCache'];
  for(const point of array(cache?.pt)){
   const index=Number(point['@_idx']);if(!Number.isSafeInteger(index)||index<0||firstRow+index>lastRow)throw new Error('Invalid generated chart cache point');
   const key=`${firstCol}:${firstRow+index}`,value=String(point.v??'');
   if(numeric&&!Number.isFinite(Number(value)))throw new Error('Invalid generated chart numeric cache');
   const old=cells.get(key);if(old&&(old.value!==value||old.numeric!==numeric))throw new Error('Generated chart caches disagree about their workbook data');
   cells.set(key,{value,numeric});if(cells.size>100000)throw new Error('Generated chart workbook cell budget exceeded');
  }
 };
 const walk=(value:any)=>{if(Array.isArray(value)){value.forEach(walk);return}if(!value||typeof value!=='object')return;for(const [k,v] of Object.entries(value)){if(k==='strRef')array(v).forEach(r=>add(r,false));else if(k==='numRef')array(v).forEach(r=>add(r,true));else walk(v)}};
 walk(parser.parse(chart));if(!cells.size)return null;
 const rows=new Map<number,{col:number;value:string;numeric:boolean}[]>();for(const [key,cell] of cells){const [col,row]=key.split(':').map(Number);if(!rows.has(row))rows.set(row,[]);rows.get(row)!.push({col,...cell})}
 const data=[...rows].sort(([a],[b])=>a-b).map(([row,values])=>`<row r="${row}">${values.sort((a,b)=>a.col-b.col).map(cell=>{const r=`${colName(cell.col)}${row}`;return cell.numeric?`<c r="${r}"><v>${xml(cell.value)}</v></c>`:`<c r="${r}" t="inlineStr"><is><t xml:space="preserve">${xml(cell.value)}</t></is></c>`}).join('')}</row>`).join('');
 const zip=new JSZip();
 zip.file('[Content_Types].xml',`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
 zip.file('_rels/.rels',`<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${DOCREL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
 zip.file('xl/workbook.xml',`<workbook xmlns="${MAIN}" xmlns:r="${DOCREL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
 zip.file('xl/_rels/workbook.xml.rels',`<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${DOCREL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
 zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="${MAIN}"><sheetData>${data}</sheetData></worksheet>`);
 return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}

/** Imported external workbooks retain their original relationship and data. Only this adapter's data is refreshed. */
export async function synchronizeGeneratedChartWorkbooks(bytes:Uint8Array,baseline?:ReadonlyMap<string,Uint8Array>):Promise<Uint8Array>{
 const zip=await JSZip.loadAsync(bytes);let changed=false;
 for(const path of Object.keys(zip.files).filter(p=>/^ppt\/charts\/chart\d+\.xml$/.test(p))){
  let chart=await zip.file(path)!.async('string');
  const prior=baseline?.get(path);
  if(prior&&new TextDecoder().decode(prior)===chart)continue;
  const file=path.split('/').pop()!,relsPath=`ppt/charts/_rels/${file}.rels`,rels=await zip.file(relsPath)?.async('string');
  const relationships=array(parser.parse(rels??'<Relationships/>').Relationships?.Relationship);
  const existingId=/<c:externalData\b[^>]*\br:id="([^"]+)"/.exec(chart)?.[1];
  const existing=relationships.find(r=>r['@_Id']===existingId);
  if(existingId&&!/^\.\.\/embeddings\/pm-chart-data-\d+\.xlsx$/.test(existing?.['@_Target']??''))continue;
  const data=await cachedWorkbook(chart);if(!data)continue;
  const ordinal=/chart(\d+)\.xml/.exec(file)![1],target=`../embeddings/pm-chart-data-${ordinal}.xlsx`;
  let id=existingId;if(!id){let n=1;while(relationships.some(r=>r['@_Id']===`rId${n}`))n++;id=`rId${n}`;relationships.push({'@_Id':id,'@_Type':`${DOCREL}/package`,'@_Target':target});chart=chart.replace('</c:chartSpace>',`<c:externalData r:id="${id}"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`)}
  zip.file(path,chart);zip.file(`ppt/embeddings/pm-chart-data-${ordinal}.xlsx`,data);
  zip.file(relsPath,`<Relationships xmlns="${REL}">${relationships.map(r=>`<Relationship ${Object.entries(r).filter(([k])=>k.startsWith('@_')).map(([k,v])=>`${k.slice(2)}="${xml(v)}"`).join(' ')}/>`).join('')}</Relationships>`);changed=true;
 }
 if(!changed)return bytes;
 let types=await zip.file('[Content_Types].xml')!.async('string');if(!/<Default\b[^>]*\bExtension="xlsx"/.test(types))types=types.replace('</Types>','<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/></Types>');zip.file('[Content_Types].xml',types);
 return zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
}
