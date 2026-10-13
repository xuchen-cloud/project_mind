import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import {parseGfmWithMath,MarkdownText,markdownImageReferences,withResolvedMarkdownImages,localResourcePath,readSourceText,writeSourceText,parseDocText,serializeDocText} from './build/entry.mjs';

const root=new URL('./',import.meta.url);
await mkdir(new URL('./evidence/',root),{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const checks=[];const check=(name,passed,details)=>checks.push({name,passed,...(details?{details}: {})});
const lines=['# 中文项目 😀','', '项目进展正常  ','第二行\t保留空格  ','',
 '| 名称 | 状态 |','| :--- | ---: |','| 甲\\|乙 | **正常** |','',
 '- [x] 已完成','- [ ] 待处理','  - 子项','', '3. 第三项','4. 第四项','',
 '> 引用正文','> 第二行','', '````ts info','const x = "中文";','```','![不是图片](fake.png)','````','',
 '![流程](images/%E5%9B%BE.png "图片标题")','![引用图][diagram]','[资料][link]','',
 '[diagram]: images/reference.png "引用图"','[link]: https://example.test/source "来源"','',
 '[危险](javascript:alert%281%29)','<script>window.injection=1</script>','<img src=x onerror="alert(1)">','<iframe src="https://evil.test"></iframe>','',
 '转义：\\*原样星号\\* 与 `内联代码`',''];
const lf=lines.join('\n');
const cases={lf,crlf:lf.replaceAll('\n','\r\n'),bom_crlf:'\uFEFF'+lf.replaceAll('\n','\r\n'),no_final_newline:lf.slice(0,-1),mixed:'\uFEFF'+lf.replace('\n','\r\n').replace('第二行\t保留空格  \n','第二行\t保留空格  \r'),classic_cr:lf.replaceAll('\n','\r')};
const sourceCases=[];
for(const [name,text] of Object.entries(cases)){
 const original=Buffer.from(text,'utf8');const beforeHash=hash(original);
 const path=new URL(`evidence/${name}.original.md`,root);await writeFile(path,original);
 const unchanged=await readFile(path);await writeFile(new URL(`evidence/${name}.noop.md`,root),unchanged);
 const old=Buffer.from('项目进展正常');const replacement=Buffer.from('项目进展更新');const at=unchanged.indexOf(old);
 const candidate=Buffer.concat([unchanged.subarray(0,at),replacement,unchanged.subarray(at+old.length)]);
 await writeFile(new URL(`evidence/${name}.edited.md`,root),candidate);
 const saved=await readFile(new URL(`evidence/${name}.edited.md`,root));
 check(`${name}:no_op_byte_identical`,hash(unchanged)===beforeHash);
 check(`${name}:only_target_utf8_bytes_changed`,saved.equals(Buffer.from(text.replace('项目进展正常','项目进展更新'))));
 check(`${name}:original_hash_unchanged`,hash(await readFile(path))===beforeHash);
 const parsed=readSourceText(text);const coreRoundtrip=writeSourceText(parsed.text,parsed.format);
 const envelope=parseDocText(text);const envelopeRoundtrip=serializeDocText(envelope,envelope.body);
 sourceCases.push({name,originalSha256:beforeHash,editedSha256:hash(saved),bytes:original.length,genofficeReadWriteHelperExact:coreRoundtrip===text,genofficeEnvelopeHelperExact:envelopeRoundtrip===text,format:parsed.format});
}
const tree=parseGfmWithMath(lf);const nodes=[];const walk=n=>{nodes.push(n);for(const child of n.children??[])walk(child)};walk(tree);
check('GFM_table',nodes.some(n=>n.type==='table'&&n.children[1].children[0].children[0].value==='甲|乙'));
check('GFM_task_checked_and_unchecked',nodes.filter(n=>n.type==='listItem'&&typeof n.checked==='boolean').length===2);
check('fence_embedded_fake_image_is_code',nodes.some(n=>n.type==='code'&&n.value.includes('fake.png'))&&!markdownImageReferences(lf).includes('fake.png'));
check('blockquote_and_ordered_list_start',nodes.some(n=>n.type==='blockquote')&&nodes.some(n=>n.type==='list'&&n.ordered&&n.start===3));
const resources={};const refs=markdownImageReferences(lf);
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
for(const ref of refs)resources[ref]=png;
const prepared=withResolvedMarkdownImages(lf,resources);
check('authored_relative_path_decode',localResourcePath('images/%E5%9B%BE.png?size=2#x')==='images/图.png');
check('reference_image_is_found',refs.includes('images/reference.png'));
check('resource_rewrite_changes_preview_only',lf.includes('images/%E5%9B%BE.png')&&!prepared.includes('![流程](images/%E5%9B%BE.png'));
const html=renderToStaticMarkup(React.createElement(MarkdownText,{text:prepared,streaming:false,labels:{code:{copyLabel:'复制',copiedLabel:'已复制'},footnotes:'脚注'},pathImages:{resolve:value=>/^data:image\//i.test(value)?value:undefined}}));
await writeFile(new URL('evidence/preview.html',root),html);
const document=new JSDOM(html).window.document;
check('actual_preview_table',document.querySelectorAll('table').length===1);
check('actual_preview_tasks_disabled',document.querySelectorAll('input[type=checkbox][disabled]').length===2);
check('actual_preview_images_data_url',document.querySelectorAll('img').length===2&&[...document.querySelectorAll('img')].every(n=>n.getAttribute('src')===png));
check('actual_preview_Chinese_and_reference_link',document.body.textContent.includes('中文项目')&&document.querySelector('a[href="https://example.test/source"]')!==null);
check('HTML_literals_no_active_nodes',document.querySelector('script,iframe,form')===null&&document.body.textContent.includes('<script>window.injection=1</script>'));
check('no_JS_hrefs_or_event_attributes',![...document.querySelectorAll('*')].some(n=>[...n.attributes].some(a=>/^on/i.test(a.name)||/^(href|src)$/.test(a.name)&&/^javascript:/i.test(a.value))));
// Record a real resource helper limitation without changing application code.
const duplicate='![重复][dup]\n\n[dup]: images/first.png\n[dup]: images/second.png\n';
const duplicateRefs=markdownImageReferences(duplicate);
const defs=parseGfmWithMath(duplicate).children.filter(n=>n.type==='definition');
const limitations={genofficeSourceHelpers:{mixedExact:sourceCases.find(x=>x.name==='mixed').genofficeReadWriteHelperExact,classicCRExact:sourceCases.find(x=>x.name==='classic_cr').genofficeReadWriteHelperExact,scope:'Actual fixed-SHA pure helpers only; full Tiptap/source-map/Electron save flow not run'},duplicateReferenceImages:{firstCommonMarkDefinition:defs[0].url,currentResourceHelperReferences:duplicateRefs,matchesFirstDefinition:duplicateRefs[0]===defs[0].url},resourceMimeAndOwnership:'Probe uses a supplied PNG map. Project File resolution, native path/ownership budgets and network blocking inspected statically, not invoked here.',editorAndCAS:'Byte-splice demonstration only; no DOM textarea/CodeMirror/IME/undo or native File/CAS commit executed.'};
const output={status:checks.every(x=>x.passed)?'passed':'failed',node:process.version,upstreamSha:'d32d1711f1bf985430757b8c6b3fbddd3831d946',checks,sourceCases,preview:{parser:'Existing parseGfmWithMath',renderer:'Existing MarkdownText SSR',htmlSha256:hash(html),resourceReferences:refs},limitations};
await writeFile(new URL('results.json',root),JSON.stringify(output,null,2));
console.log(JSON.stringify({status:output.status,checks:checks.length,failed:checks.filter(x=>!x.passed).map(x=>x.name),sourceCases,limitations},null,2));
if(output.status!=='passed')process.exitCode=1;
