import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=resolve(import.meta.dirname,'../..');
const require=createRequire(resolve(root,'packages/office-xlsx/package.json'));
const JSZip=require('jszip');
export async function generateFixtures(output){
 await mkdir(output,{recursive:true});const samples=[];
 for(const format of ['docx','pptx','xlsx'])for(const tier of ['small','complex','large'])for(const variant of ['a','b']){
  const base=tier==='small'?'simple':'complex';
  const source=resolve(root,format==='docx'?`packages/office-docx/test/fixtures/${base}.original.docx`:format==='xlsx'?`packages/office-xlsx/tests/fixtures/${base}.original.xlsx`:`packages/genoffice-pptx-validation/${base}.original.pptx`);
  const zip=await JSZip.loadAsync(await readFile(source));const witness=`PERF_${format}_${tier}_${variant}`;
  let dimensions;
  if(format==='docx'){
   let xml=await zip.file('word/document.xml').async('string');
   xml=xml.replace(/(<w:t\b[^>]*>)([^<]*)/,`$1${witness} $2`);
   if(tier==='large'){
    // Earlier sections can carry sectPr inside paragraph properties. Appending
    // there would produce invalid nested paragraphs that the parser ignores.
    const bodyEnd=xml.lastIndexOf('</w:body>'),section=xml.lastIndexOf('<w:sectPr',bodyEnd);
    if(bodyEnd<0||section<0)throw Error('Fixture body section missing');
    const paragraphs=Array.from({length:500},(_,i)=>`<w:p><w:r><w:t>Performance paragraph ${i}: reproducible document layout, tables and fonts.</w:t></w:r></w:p>`).join('');
    xml=xml.slice(0,section)+paragraphs+xml.slice(section);
   }
   zip.file('word/document.xml',xml);dimensions={paragraphs:(xml.match(/<w:p[ >]/g)||[]).length};
  }else if(format==='xlsx'){
   let xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
   // A visible string and a deterministic calculation probe; no original files are modified.
   xml=xml.replace(/<c\b[^>]*\br="A1"[^>]*>[\s\S]*?<\/c>/,`<c r="A1" t="inlineStr"><is><t>${witness}</t></is></c>`);
   if(!xml.includes(witness))throw Error('Fixture A1 missing');
   if(tier==='large'){
    const rows=Array.from({length:10000},(_,i)=>`<row r="${i+1001}"><c r="A${i+1001}" t="inlineStr"><is><t>Row ${i}</t></is></c><c r="B${i+1001}"><v>${i}</v></c><c r="C${i+1001}"><f>B${i+1001}*2</f><v>${i*2}</v></c></row>`).join('');
    xml=xml.replace('</sheetData>',rows+'</sheetData>').replace(/<dimension\b[^>]*\/>/,'<dimension ref="A1:P11000"/>');
   }
   zip.file('xl/worksheets/sheet1.xml',xml);dimensions={rows:(xml.match(/<row[ >]/g)||[]).length,formulas:(xml.match(/<f[ >]/g)||[]).length};
  }else{
   let xml=await zip.file('ppt/slides/slide1.xml').async('string');xml=xml.replace(/(<a:t\b[^>]*>)([^<]*)/,`$1${witness} $2`);zip.file('ppt/slides/slide1.xml',xml);
   if(tier==='large'){
    let presentation=await zip.file('ppt/presentation.xml').async('string'),rels=await zip.file('ppt/_rels/presentation.xml.rels').async('string'),types=await zip.file('[Content_Types].xml').async('string');
    const existing=Object.keys(zip.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p));const start=Math.max(...existing.map(p=>Number(/slide(\d+)/.exec(p)[1])))+1;
    const slideRels=zip.file('ppt/slides/_rels/slide1.xml.rels');
    for(let i=0;i<37;i++){const n=start+i,id=`perfSlide${n}`;zip.file(`ppt/slides/slide${n}.xml`,xml.replace(witness,`Performance slide ${n}`));if(slideRels)zip.file(`ppt/slides/_rels/slide${n}.xml.rels`,await slideRels.async('string'));presentation=presentation.replace('</p:sldIdLst>',`<p:sldId id="${10000+n}" r:id="${id}"/></p:sldIdLst>`);rels=rels.replace('</Relationships>',`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/></Relationships>`);types=types.replace('</Types>',`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`)}
    zip.file('ppt/presentation.xml',presentation);zip.file('ppt/_rels/presentation.xml.rels',rels);zip.file('[Content_Types].xml',types);
   }
   dimensions={slides:Object.keys(zip.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).length};
  }
  // Normalize archive timestamps so fixture hashes are repeatable.
  for(const file of Object.values(zip.files))file.date=new Date('2020-01-01T00:00:00Z');
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE',compressionOptions:{level:6}}),id=`${format}-${tier}-${variant}`,path=resolve(output,`${id}.${format}`);
  await writeFile(path,bytes);samples.push({id,format,tier,variant,path,witness,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source,dimensions});
 }
 await writeFile(resolve(output,'manifest.json'),JSON.stringify(samples,null,2));return samples;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await generateFixtures(resolve(process.argv[2]??'scripts/office-performance/output/fixtures'));
