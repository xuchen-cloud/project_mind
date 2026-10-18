import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

test('external PPT renderer preserves the complete script, styles and font bytes', async () => {
 const dist=new URL('../dist/',import.meta.url);
 const manifest=JSON.parse(await readFile(new URL('renderer-resources.json',dist),'utf8'));
 const generated=await readFile(new URL('../parity-html.ts',import.meta.url),'utf8');
 const legacy=JSON.parse(generated.slice(generated.indexOf('export const parityHtml=')+'export const parityHtml='.length).trim().replace(/;$/,''));
 const originalCss=legacy.match(/<style>([\s\S]*?)<\/style>/)[1];
 const originalJs=legacy.match(/<script>([\s\S]*?)<\/script>/)[1];
 const externalJs=(await readFile(new URL('renderer.mjs',dist),'utf8')).replace(/<\/script/gi,'<\\/script');
 const digest=value=>createHash('sha256').update(value).digest('hex');
 assert.equal(digest(externalJs),digest(originalJs),'The external renderer must contain the identical full script');
 const css=await readFile(new URL('renderer.css',dist),'utf8');
 let normalizedOriginal=originalCss,normalizedExternal=css,fontCount=0;
 for(const match of originalCss.matchAll(/url\(["']?(data:([^;,]+)(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+))["']?\)/g)){
  if(!/font|octet-stream/.test(match[2]))continue;
  const bytes=Buffer.from(match[3],'base64');
  const hash=createHash('sha256').update(bytes).digest('hex').slice(0,20);
  const path=manifest.files.find(file=>file.startsWith(`renderer-fonts/${hash}.`));
  assert.ok(path,`Missing original font ${hash}`);
  assert.deepEqual(await readFile(new URL(path,dist)),bytes);
  normalizedOriginal=normalizedOriginal.replace(match[0],`FONT(${hash})`);
  normalizedExternal=normalizedExternal.replace(`url("./${path}")`,`FONT(${hash})`);
  fontCount++;
 }
 assert.ok(fontCount>0);
 assert.equal(digest(normalizedExternal),digest(normalizedOriginal),'Only font resource addressing may change CSS');
 const html=await readFile(new URL(manifest.entry,dist),'utf8');
 assert.ok(html.length<1024);assert.doesNotMatch(html,/data:|<style>/);
 assert.match(html,/type:'resource-error'/);
 for(const path of manifest.files) assert.ok((await readFile(new URL(path,dist))).length>0);
});
