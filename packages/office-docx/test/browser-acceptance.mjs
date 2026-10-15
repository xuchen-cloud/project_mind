/** Opt-in real-browser acceptance; caller supplies its installed Playwright module. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.OFFICE_PLAYWRIGHT_MODULE || !process.env.OFFICE_ACCEPTANCE_URL)
  throw Error('Set OFFICE_PLAYWRIGHT_MODULE to an installed Playwright index.mjs and OFFICE_ACCEPTANCE_URL to browser-server.mjs URL');
const playwright = await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href);
const out = resolve(import.meta.dirname, 'output/browser');
await mkdir(out, { recursive: true });
const results = [];
for (const name of ['chromium', 'webkit']) {
  const browser = await playwright[name].launch({ headless: true, ...(name === 'chromium' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) errors.push(message.text()); });
    await page.goto(process.env.OFFICE_ACCEPTANCE_URL);
    const body = page.getByRole('textbox', { name: 'Word 文档内容', exact: true });
    await body.waitFor();
    const title = page.locator('[data-style="Title"]');
    assert.ok(parseFloat(await title.evaluate(node => getComputedStyle(node).fontSize)) > 30, 'Original 26pt title style must render');
    const paragraph = body.locator('p[data-idx="2"]');
    const cell = body.locator('tr').nth(1).locator('td').nth(1).locator('p');
    async function replace(locator, text) {
      await locator.click({ clickCount: 3 });
      await page.keyboard.insertText(text);
      await page.waitForFunction(() => window.officeDocxHarness.edits().length === 1);
      assert.equal(await locator.textContent(), text);
    }
    await replace(paragraph, `${name} 第一轮中文：秋风拂面。`);
    await replace(cell, `${name} 中文单元格`);
    await page.evaluate(() => window.officeDocxHarness.setReadOnly(true));
    await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Word 文档内容"]').contentEditable === 'false');
    assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).isDisabled(), true);
    await page.evaluate(() => window.officeDocxHarness.save());
    await page.waitForFunction(() => window.officeDocxHarness.edits().length === 0);
    await page.evaluate(() => window.officeDocxHarness.setReadOnly(false));
    await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Word 文档内容"]').contentEditable === 'true');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await paragraph.textContent(), `${name} 第一轮中文：秋风拂面。`, 'Commit clears old undo history');
    await replace(paragraph, `${name} 第二轮中文：冬雪纷飞。`);
    await page.evaluate(() => window.officeDocxHarness.save());
    await page.reload();
    await page.getByRole('textbox', { name: 'Word 文档内容', exact: true }).waitFor();
    assert.equal(await paragraph.textContent(), `${name} 第二轮中文：冬雪纷飞。`);
    assert.equal(await cell.textContent(), `${name} 中文单元格`);
    assert.equal(await body.locator('img.doc-protected-img').evaluate(node => node.naturalWidth), 160);
    await page.screenshot({ path: resolve(out, `docx-${name}-wide.png`) });
    await page.setViewportSize({ width: 480, height: 800 });
    const edges = async position => {
      await page.evaluate(position => {
        const node = document.querySelector('.office-docx__viewport');
        const max = node.scrollHeight - node.clientHeight;
        node.scrollTop = position === 'bottom' ? max : position === 'middle' ? max / 2 : Number(position);
        node.dispatchEvent(new Event('scroll', { bubbles: true }));
      }, position);
      // React commits edge state on the next animation frame.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return page.evaluate(() => ({
        top: Number(document.querySelector('.office-docx__edge--top').style.opacity),
        bottom: Number(document.querySelector('.office-docx__edge--bottom').style.opacity),
      }));
    };
    assert.deepEqual(await edges(0), { top: 0, bottom: 1 });
    const partial = await edges(16);
    assert.ok(partial.top > 0 && partial.top < 1);
    assert.deepEqual(await edges('middle'), { top: 1, bottom: 1 });
    assert.deepEqual(await edges('bottom'), { top: 1, bottom: 0 });
    assert.deepEqual(await edges(0), { top: 0, bottom: 1 });
    assert.equal(await page.locator('.office-docx__viewport').evaluate(node => node.scrollWidth === node.clientWidth), true);
    await page.screenshot({ path: resolve(out, `docx-${name}-narrow.png`) });
    await page.setViewportSize({ width: 1440, height: 1600 });
    await page.waitForFunction(() => document.querySelector('.office-docx__edge--top').style.opacity === '0' && document.querySelector('.office-docx__edge--bottom').style.opacity === '0');
    assert.equal(errors.length, 0, errors.join('\n'));
    results.push({ browser: name, version: browser.version(), headless: true, rounds: 2, chineseParagraph: true,
      chineseTableCell: true, image: true, readOnlySaving: true, committedHistoryCleared: true,
      originalTitleStyle: true, narrowNoHorizontalOverflow: true, continuousScrollEdges: true, consoleErrors: errors });
  } finally { await browser.close(); }
}
await writeFile(resolve(out, 'acceptance-results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
