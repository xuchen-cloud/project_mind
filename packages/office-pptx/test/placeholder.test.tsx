import {expect,test} from 'vitest';
import {readFile} from 'node:fs/promises';
import {inspect,edit} from '../dist/engine.mjs';
import {suppressFilledSlidePrompts} from '../placeholder-prompts';

test('real source placeholders remain empty and editable; filled slides hide only editor hints, new layout placeholders stay editable',async()=>{
 const source=new Uint8Array(await readFile('test/fixtures/complex.pptx'));
 const model=await inspect(source),render=suppressFilledSlidePrompts(model.renderSlides![0]);
 expect(render.nodes.filter(n=>'placeholder' in n&&n.placeholder).map(n=>n.sourceId)).toEqual(['slide-0:shape-2','slide-0:shape-3']);
 expect(render.nodes.filter(n=>'placeholder' in n&&n.placeholder).every(n=>(n as any).projectMindSuppressPrompt)).toBe(true);
 const saved=await edit(source,[{kind:'command',name:'slides:add-slide-with-layout',args:[{sourceIndex:0,layoutPath:'ppt/slideLayouts/slideLayout1.xml',fitWidthPx:1280}]}]);
 const added=await inspect(saved),fresh=suppressFilledSlidePrompts(added.renderSlides![1]);const placeholders=fresh.nodes.filter(n=>'placeholder' in n&&n.placeholder);
 expect(placeholders.length).toBeGreaterThan(0);expect(placeholders.every(n=>!(n as any).projectMindSuppressPrompt)).toBe(true);
 const target=placeholders[0].sourceId!.replace(/^slide-\d+:shape-/, 'e_');const edited=await edit(saved,[{kind:'command',name:'slides:edit-text',args:[{slideIndex:1,sourceId:target,paragraphs:[{runs:[{text:'真实新建标题'}]}]}]}]);
 expect((await inspect(edited)).textElements.some(t=>t.slideIndex===1&&t.text==='真实新建标题')).toBe(true);
 const filled=suppressFilledSlidePrompts((await inspect(edited)).renderSlides![1]);expect(filled.nodes.flatMap(n=>'text' in n?n.text?.lines.flatMap(l=>l.runs.map(r=>r.text))??[]:[]).join('')).toContain('真实新建标题');
 expect((await inspect(edited)).textElements.some(t=>t.text.includes('单击此处添加'))).toBe(false);
});
