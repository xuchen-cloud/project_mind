import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Commit generated public contracts with the skill, so its read-only references
// remain usable in a packaged assistant without Node package/path authority.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const refs=path.join(root,'packages/dsh-assistant/skills/genoffice-authoring/references');
const check=process.argv.includes('--check');
const generated=new Map();
const json=(name,value)=>generated.set(name,JSON.stringify(value,null,2)+'\n');
for(const [format,name] of [['docx','word'],['xlsx','excel'],['pptx','powerpoint']]){
  const packageRoot=path.join(root,`packages/office-${format}`);
  const engine=await import(new URL(`../packages/office-${format}/dist/engine.mjs`,import.meta.url));
  let guide=await readFile(path.join(packageRoot,'authoring.md'),'utf8');
  guide='Use this format contract through `file_office_create` (`content`) or `file_office_edit` (`edits`). Package-level engine names below describe the data contract, not commands to execute from the assistant.\n\n'+guide;
  if(format==='docx')guide=guide.replace(/Call `engine\.catalog\(\)` or read the build-generated `dist\/authoring-catalog\.json`/, 'Read [the actual operation catalog](word-catalog.json)');
  if(format==='xlsx')guide=guide.replace('`createJsonSchema` / `gatewayChangesJsonSchema`','[creation schema](excel-create.schema.json) / [gateway schema](excel-gateway.schema.json)');
  if(format==='pptx')guide=guide.replace('Read these before constructing complex operations.', 'Read [the public contract](powerpoint-contract.json) before constructing complex operations.').replace(/The pinned upstream op guides live in .*?immutable upstream resources covered by `source-lock\.json`\./s,'Read the [native operation groups](powerpoint-ops.md) for nested operation fields, and [presentation design](presentation-design.md) for the staged workflow.');
  generated.set(`${name}.md`,guide);
  if(format==='docx')json('word-catalog.json',await engine.catalog());
  if(format==='xlsx'){
    json('excel-create.schema.json',engine.createJsonSchema);
    json('excel-gateway.schema.json',engine.gatewayChangesJsonSchema);
  }
  if(format==='pptx')json('powerpoint-contract.json',{schema:engine.creationSchema,operationFields:engine.creationOperationFields});
}
const source=JSON.parse(await readFile(path.join(refs,'upstream-sources.json'),'utf8'));
for(const row of source.files){
  const bytes=await readFile(path.join(refs,row.file));
  if(createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw Error(`Upstream Skill provenance mismatch: ${row.file}`);
}
await mkdir(refs,{recursive:true});
for(const [name,value] of generated){
  if(check){
    if(await readFile(path.join(refs,name),'utf8')!==value)throw Error(`Stale Office authoring reference: ${name}`);
  }else await writeFile(path.join(refs,name),value);
}
console.log(`Office authoring references ${check?'verified':'synchronized'} (${generated.size} files).`);
