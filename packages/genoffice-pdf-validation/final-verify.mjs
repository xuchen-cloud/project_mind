// Extracts unchanged private verification bodies, not a substitute implementation.
// Exercises only their text branch; full save-pdf/image editing remain out of scope.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const scratch=process.env.GENOFFICE_PDF_SCRATCH??'/tmp/project-mind-genoffice-pdf-validation-20261013';
const req=createRequire(path.join(scratch,'package.json'));
const upstream=path.join(scratch,'upstream/apps/pdf/src/main');
const url='https://raw.githubusercontent.com/genspark-ai/genoffice/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/pdf/src/main/save-pdf.ts';
const response=await fetch(url);if(!response.ok)throw new Error(`fetch save-pdf: ${response.status}`);
const source=await response.text();await fs.writeFile(path.join(upstream,'save-pdf.ts'),source);
const start=source.indexOf('function finalPageIndex('),end=source.indexOf('\nexport async function savePdfToPath(',start);
if(start<0||end<0)throw new Error('Fixed source verifier extraction boundary missing');
const bodies=source.slice(start,end);
const bundle=path.join(scratch,'generated/final-verifier.mjs');
await req('esbuild').build({stdin:{contents:bodies+'\nexport { verifyContentEdits };\n',resolveDir:upstream,sourcefile:'extracted-final-verifier.ts',loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node24',outfile:bundle,alias:{'@genoffice/font-metrics':path.join(scratch,'upstream/packages/font-metrics/src/index.ts')},external:['@embedpdf/pdfium','pdf-lib','./image-edit']});
const {verifyContentEdits}=await import(pathToFileURL(bundle).href);const {PDFDocument}=req('pdf-lib');
const manifest=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8'));
const report={source_url:url,source_sha256:crypto.createHash('sha256').update(source).digest('hex'),extracted_body_sha256:crypto.createHash('sha256').update(bodies).digest('hex'),transformation:'Exact finalPageIndex/verifyContentEdits function bodies plus export; no behavior changes. esbuild bundles real text-edit module. Actual unused image-edit import remains external, not shimmed.',runs:[],full_save_pipeline:false};
for(const [name,fixture] of Object.entries(manifest)){
 const bytes=await fs.readFile(path.join(root,`${name}.core-edited.pdf`));
 const doc=await PDFDocument.load(bytes,{updateMetadata:false});const roundtrip=await doc.save({useObjectStreams:false,updateFieldAppearances:false});
 const output=path.join(root,`${name}.pdflib-final-stage.pdf`);await fs.writeFile(output,roundtrip);
 const skips={skippedTextEdits:[],skippedTextInserts:[],skippedImageEdits:[]};
 const row={name,output,sha256:crypto.createHash('sha256').update(roundtrip).digest('hex'),status:'failed'};
 try{await verifyContentEdits(roundtrip,{textEdits:[fixture.target]},skips);row.status='passed';}catch(e){row.error=String(e.message);}
 try{await verifyContentEdits(roundtrip,{textEdits:[{...fixture.target,newText:'CONTROLLED TEXT MISSING FROM FINAL PDF'}]},skips);row.missing_text_guard={status:'failed',reason:'Expected verifier rejection did not occur'};}catch(e){row.missing_text_guard={status:'passed',error:String(e.message)};}
 report.runs.push(row);
}
await fs.writeFile(path.join(root,'final-verify-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
