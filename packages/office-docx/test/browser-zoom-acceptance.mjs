/** Word fixed-paper/zoom acceptance. Uses the existing browser-server.mjs host. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.env.OFFICE_PLAYWRIGHT_MODULE || !process.env.OFFICE_ACCEPTANCE_URL)
  throw Error('Set OFFICE_PLAYWRIGHT_MODULE and OFFICE_ACCEPTANCE_URL (browser-server.mjs)');
const playwright = await import(pathToFileURL(resolve(process.env.OFFICE_PLAYWRIGHT_MODULE)).href);
for (const name of ['chromium', 'webkit']) {
  const browser = await playwright[name].launch({ headless: true, ...(name === 'chromium' ? { channel: 'chrome' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    const paragraphText = `${name} ${Date.now()} 缩放后仍可编辑保存。`;
    const cellText = `${name} ${Date.now()} 缩放表格`;
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(process.env.OFFICE_ACCEPTANCE_URL);
    const body = page.getByRole('textbox', { name: 'Word 文档内容', exact: true });
    await body.waitFor();
    const model = await (await page.request.get(new URL('/model', process.env.OFFICE_ACCEPTANCE_URL).href)).json();
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const metrics = () => page.evaluate(() => {
      const paper = document.querySelector('.office-docx__paper');
      const viewport = document.querySelector('.office-docx__viewport');
      const content = document.querySelector('.office-docx-content');
      const style = getComputedStyle(paper);
      const table = content.querySelector('table');
      return {
        width: paper.offsetWidth, height: paper.offsetHeight, renderedWidth: paper.getBoundingClientRect().width,
        margins: ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(style[`padding${side}`])),
        lines: [...content.querySelectorAll('p')].map(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
        }),
        contentHeight: content.offsetHeight, tableWidth: table.offsetWidth, font: getComputedStyle(content).fontSize,
        zoom: parseFloat(getComputedStyle(document.querySelector('.office-docx__stage')).getPropertyValue('--office-doc-zoom')), scrollWidth: viewport.scrollWidth, clientWidth: viewport.clientWidth,
        scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight,
        available: viewport.clientWidth - parseFloat(getComputedStyle(viewport).paddingLeft) - parseFloat(getComputedStyle(viewport).paddingRight),
        edges: Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, Number(document.querySelector(`.office-docx__edge--${side}`).style.opacity)])),
      };
    });
    // Classic scrollbars consume width. At this height, fit zoom used to alternate
    // between overflowing and fitting, recursively updating React layout effects.
    await page.addStyleTag({ content: '* { scrollbar-width:auto !important; } *::-webkit-scrollbar { width:8px; height:8px; }' });
    await page.setViewportSize({ width: 800, height: 1600 });
    await settle();
    const threshold = await page.evaluate(() => {
      const paper = document.querySelector('.office-docx__paper');
      const viewport = document.querySelector('.office-docx__viewport');
      const style = getComputedStyle(viewport);
      const available = viewport.offsetWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return Math.round(document.querySelector('.office-docx__toolbar').offsetHeight
        + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        + paper.offsetHeight * (available - 4) / paper.offsetWidth);
    });
    for (const height of [threshold, threshold - 12, threshold + 12, threshold]) {
      await page.setViewportSize({ width: 800, height });
      await settle();
      assert.deepEqual(errors, [], 'Fit zoom must converge at the vertical scrollbar threshold');
      assert.ok(await body.isVisible(), 'Word remains mounted after resize');
      const current = await metrics();
      assert.ok(Math.abs(current.zoom - current.available / model.page.width) < 0.002);
      assert.ok(current.scrollWidth <= current.clientWidth + 1);
    }
    await page.setViewportSize({ width: 1100, height: 800 });
    await settle();
    const baseline = await metrics();
    assert.ok(Math.abs(baseline.width - model.page.width) <= 1);
    assert.deepEqual(baseline.margins, ['top', 'right', 'bottom', 'left'].map(side => model.page.margins[side]));
    assert.ok(baseline.height >= model.page.height - 1);
    async function layout(width) {
      await page.setViewportSize({ width, height: 650 });
      await settle();
      const current = await metrics();
      assert.equal(current.width, baseline.width, 'Paper keeps source width');
      assert.deepEqual(current.margins, baseline.margins, 'Margins never respond to viewport width');
      assert.deepEqual(current.lines, baseline.lines, 'Text line wrapping remains unchanged');
      assert.equal(current.contentHeight, baseline.contentHeight, 'Content height remains unchanged');
      assert.equal(current.tableWidth, baseline.tableWidth, 'Table layout remains unchanged');
      assert.equal(current.font, baseline.font, 'Original font size remains unchanged');
      assert.ok(Math.abs(current.renderedWidth - model.page.width * current.zoom) < 1);
      return current;
    }
    const narrow = await layout(600);
    assert.ok(narrow.zoom >= 0.5 && narrow.zoom < baseline.zoom);
    assert.ok(narrow.scrollWidth <= narrow.clientWidth + 1, 'Fit width must not overflow above the 50% floor');
    assert.ok(Math.abs(narrow.zoom - narrow.available / model.page.width) < 0.002);
    const tiny = await layout(300);
    assert.equal(tiny.zoom, 0.5);
    assert.ok(tiny.scrollWidth > tiny.clientWidth, '50% floor exposes horizontal scroll');
    assert.equal(tiny.edges.left, 0);
    assert.equal(tiny.edges.right, 1);
    async function scroll(axis, value) {
      await page.locator('.office-docx__viewport').evaluate((node, { axis, value }) => {
        const max = axis === 'x' ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
        node[axis === 'x' ? 'scrollLeft' : 'scrollTop'] = value === 'end' ? max : value;
        node.dispatchEvent(new Event('scroll'));
      }, { axis, value });
      await settle();
      return (await metrics()).edges;
    }
    const partial = await scroll('x', 16);
    assert.ok(partial.left > 0 && partial.left < 1);
    assert.equal((await scroll('x', 'end')).right, 0);
    assert.equal((await scroll('x', 0)).left, 0);
    await page.getByRole('combobox', { name: 'Word 缩放', exact: true }).selectOption('1.5');
    await settle();
    assert.equal((await metrics()).zoom, 1.5);
    assert.equal(await page.getByLabel('Word 缩放百分比', { exact: true }).textContent(), '150%');
    await layout(1100);
    assert.equal((await metrics()).zoom, 1.5, 'Manual zoom survives resize');
    const paragraph = body.locator('p[data-idx="2"]');
    const cell = body.locator('tr').nth(1).locator('td').nth(1).locator('p');
    async function replace(locator, text) {
      await locator.click({ clickCount: 3 });
      await page.keyboard.insertText(text);
      assert.equal(await locator.textContent(), text);
    }
    await replace(paragraph, paragraphText);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.notEqual(await paragraph.textContent(), paragraphText);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await paragraph.textContent(), paragraphText);
    await replace(cell, cellText);
    await page.evaluate(() => window.officeDocxHarness.setReadOnly(true));
    await settle();
    assert.equal(await body.getAttribute('contenteditable'), 'false');
    assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).isDisabled(), true);
    await page.evaluate(() => window.officeDocxHarness.save());
    await page.reload();
    await body.waitFor();
    assert.equal(await paragraph.textContent(), paragraphText);
    assert.equal(await cell.textContent(), cellText);
    await page.getByRole('combobox', { name: 'Word 缩放', exact: true }).selectOption('2');
    await settle();
    assert.equal((await metrics()).zoom, 2);
    await scroll('y', 0);
    assert.equal((await metrics()).edges.top, 0);
    assert.equal((await metrics()).edges.bottom, 1);
    const vertical = await scroll('y', 16);
    assert.ok(vertical.top > 0 && vertical.top < 1);
    assert.equal((await scroll('y', 'end')).bottom, 0);
    await page.getByRole('combobox', { name: 'Word 缩放', exact: true }).selectOption('fit');
    await page.setViewportSize({ width: 1100, height: 5000 });
    await settle();
    assert.deepEqual((await metrics()).edges, { top: 0, bottom: 0, left: 0, right: 0 });
    // Render a real long document model; layout must grow beyond the original sheet height.
    const longModel = structuredClone(model);
    const sourceParagraph = model.document.content.find(node => node.type === 'docParagraph' && node.content?.some(child => child.type === 'text'));
    assert.ok(sourceParagraph);
    longModel.document.content.push(...Array.from({ length: 100 }, () => structuredClone(sourceParagraph)));
    await page.route('**/model', route => route.fulfill({ json: longModel }));
    await page.setViewportSize({ width: 600, height: 650 });
    await page.reload();
    await body.waitFor();
    await settle();
    const long = await metrics();
    assert.ok(long.height > model.page.height * 2, 'Long documents grow vertically without clipping to one page');
    assert.ok(long.scrollHeight > long.clientHeight);
    assert.equal(long.edges.bottom, 1, 'Content growth updates fades without scrolling');
    assert.equal((await scroll('y', 'end')).bottom, 0);
    assert.deepEqual(errors, []);
    console.log(`${name}: fixed geometry, fit width, 50% horizontal scroll, continuous edges, manual zoom, undo/redo, read-only, edit/save/reload, long document growth passed`);
  } finally { await browser.close(); }
}
