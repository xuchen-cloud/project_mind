import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const source=await readFile(new URL('vendor-web/web-bridge.ts',import.meta.url),'utf8');
const lock=JSON.parse(await readFile(new URL('web-source-lock.json',import.meta.url)));
if(createHash('sha256').update(source).digest('hex')!==lock.sha256)throw Error('Web bridge fixed source mismatch');
const ast=ts.createSourceFile('web-bridge.ts',source,ts.ScriptTarget.Latest,true);
const helpers=new Set(['hiddenInput','fileToBase64','pickViaInput','downloadBytes']);const result=[];
for(const node of ast.statements)if(ts.isFunctionDeclaration(node)&&helpers.has(node.name?.text))result.push(node.getText(ast));
let image,clipboard,html;
function walk(node){if(ts.isPropertyAssignment(node)){if(node.name.getText(ast)==='pickImage')image=node.initializer.getText(ast);if(node.name.getText(ast)==='copyImageToClipboard')clipboard=node.initializer.getText(ast);if(node.name.getText(ast)==='exportHtml')html=node.initializer.getText(ast);}ts.forEachChild(node,walk);}
walk(ast);if(result.length!==4||!image||!clipboard||!html)throw Error('Missing fixed browser bridge helpers');
const code=ts.transpileModule(result.join('\n')+'\nexport {pickViaInput};\nexport const pickImage='+image+';\nexport const copyImageToClipboard='+clipboard+';\nexport const exportHtml='+html+';', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
await writeFile(new URL('web-helpers.mjs',import.meta.url),'// Generated from Nothing1024/dsh-genoffice-engine@'+lock.commit+'; see vendor-web/LICENSE and NOTICE.\n'+code);
