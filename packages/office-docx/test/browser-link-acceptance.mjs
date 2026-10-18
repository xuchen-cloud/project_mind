/** Run against browser-server.mjs with OFFICE_DOCX_POISONED_LINKS=1. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { poisonedHref } from './fixtures/poisoned-links.mjs';

if (!process.env.OFFICE_PLAYWRIGHT_MODULE || !process.env.OFFICE_ACCEPTANCE_URL)
  throw Error('Set OFFICE_PLAYWRIGHT_MODULE and OFFICE_ACCEPTANCE_URL');
const playwright = await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href);
const results = [];
for (const name of ['chromium', 'webkit']) {
  const browser = await playwright[name].launch({ headless: true, ...(name === 'chromium' ? { channel: 'chrome' } : process.env.OFFICE_WEBKIT_EXECUTABLE?{executablePath:process.env.OFFICE_WEBKIT_EXECUTABLE}:{}) });
  try {
    const page = await browser.newPage();
    const errors = [], externalRequests = [], popups = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    page.on('popup', popup => popups.push(popup));
    page.on('request', request => { if (new URL(request.url()).origin !== new URL(process.env.OFFICE_ACCEPTANCE_URL).origin) externalRequests.push(request.url()); });
    await page.request.post(process.env.OFFICE_ACCEPTANCE_URL+'/reset');
    await page.goto(process.env.OFFICE_ACCEPTANCE_URL + '/?readOnly');
    const frame=page.frameLocator('iframe[title="Word 文档编辑器"]');
    const body = frame.getByRole('textbox', { name: 'Word 文档内容', exact: true });
    await body.waitFor();
    assert.equal(await body.getAttribute('contenteditable'), 'false');
    async function assertInert() {
      const links = await body.locator('a').evaluateAll(anchors => anchors.map(anchor => ({
        text: anchor.textContent, attrs: Object.fromEntries([...anchor.attributes].map(a => [a.name, a.value])),
        decoration: getComputedStyle(anchor).textDecorationLine,
      })));
      assert.equal(links.length, 2);
      for (const link of links) {
        assert.equal(link.text, '示例链接');
        assert.equal(link.attrs.role, 'link');
        assert.equal(link.attrs.title, poisonedHref);
        assert.ok(link.decoration.includes('underline'), 'Original link presentation remains');
        assert.ok(Object.keys(link.attrs).every(attr => ['role', 'title', 'class', 'style', 'data-style'].includes(attr)));
      }
      assert.equal(await body.evaluate(() => window.__officePoisonedLink), undefined);
      assert.equal(externalRequests.length, 0);
      assert.equal(popups.length, 0);
    }
    await assertInert();
    for (const anchor of await body.locator('a').all()) {
      await anchor.click();
      await page.keyboard.press('Enter');
      await anchor.click({ button: 'right' });
      await page.keyboard.press('Escape');
      await assertInert();
    }
    for (const text of [`${name} 链接保留第一轮`, `${name} 链接保留第二轮`]) {
      await page.evaluate(() => window.officeDocxHarness.setReadOnly(false));
      await body.locator('xpath=self::*[@contenteditable="true"]').waitFor();
      const paragraph = body.locator('p[data-idx="2"]');
      await paragraph.scrollIntoViewIfNeeded();const rect=await paragraph.boundingBox();await page.mouse.move(rect.x+1,rect.y+2);await page.mouse.down();await page.mouse.move(rect.x+rect.width-2,rect.y+rect.height-2,{steps:8});await page.mouse.up();
      await page.keyboard.insertText(text);
      await page.waitForFunction(() => window.officeDocxHarness.edits().length === 1);
      await assertInert();
      await page.evaluate(() => window.officeDocxHarness.save());
      await page.waitForFunction(() => window.officeDocxHarness.edits().length === 0);
      await page.reload();
      await body.waitFor();
      assert.equal(await body.getAttribute('contenteditable'), 'false');
      assert.equal(await paragraph.textContent(), text);
      await assertInert();
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    results.push({ browser: name, version: browser.version(), readonlyLinkMark: true, readonlyProtectedNodeView: true,
      noNavigationAttributes: true, clickKeyboardContextmenu: true, rounds: 2, errors, externalRequests, popups: popups.length });
  } finally { await browser.close(); }
}
await writeFile(resolve(import.meta.dirname, 'output/browser/link-acceptance-results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
