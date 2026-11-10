/** Real headless renderer, real ZIP source, real engine saves. No native claims. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import JSZip from 'jszip';
import {inspect} from '../dist/engine.mjs';
import {FIRST_ORIGINAL, SECOND_ORIGINAL, TAIL_WITNESS, APPENDED_BLOCKS} from './fixtures/progressive.mjs';
const pw = await import(pathToFileURL(process.env.OFFICE_PLAYWRIGHT_MODULE).href);
const results = [];
for (const kind of process.env.OFFICE_BROWSERS?.split(',') ?? ['chromium']) {
  const browser = await pw[kind].launch(kind === 'chromium' ? {headless: true, channel: 'chrome'} : {headless: true, executablePath: process.env.OFFICE_WEBKIT_EXECUTABLE});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [];
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      window.progressiveMetrics = {};
      let pending = false;
      const check = () => {
        pending = false;
        const editor = document.querySelector('.tiptap.doc-page');
        if (!editor?.textContent?.includes('待修改中文段落')) return;
        const rect = editor.getBoundingClientRect();
        if (!rect.width || !rect.height || getComputedStyle(editor).visibility === 'hidden') return;
        const now = performance.timeOrigin + performance.now();
        window.progressiveMetrics.firstContent ??= now;
        if (editor.getAttribute('contenteditable') === 'true') window.progressiveMetrics.firstEditable ??= now;
      };
      const observer = new MutationObserver(() => {
        if (pending) return; pending = true;
        requestAnimationFrame(() => requestAnimationFrame(check));
      });
      observer.observe(document, {childList: true, subtree: true, attributes: true});
    });
    const url = process.env.OFFICE_ACCEPTANCE_URL;
    await page.request.post(url + '/reset');
    const navigationAt = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => !!window.progressive);
    await page.evaluate(() => window.progressive.ready());
    const frame = page.frames().find(f => f.parentFrame());
    await frame.waitForFunction(() => !!window.progressiveMetrics.firstEditable);
    const initial = await frame.evaluate(() => ({...window.progressiveMetrics,
      blocks: window.__projectMindDocxHost.currentContext.doc.parsed.blocks.length,
      text: document.querySelector('.tiptap.doc-page').textContent}));
    assert.ok(initial.blocks < APPENDED_BLOCKS, 'First editable content must precede tail parsing');
    assert.ok(!initial.text.includes(TAIL_WITNESS));
    const body = frame.locator('.tiptap.doc-page').first();
    assert.equal(await frame.getByRole('slider', {name: '缩放比例'}).getAttribute('min'), '50');
    assert.equal(await frame.getByRole('slider', {name: '缩放比例'}).getAttribute('max'), '150');
    async function appendText(original, addition) {
      const paragraph = body.locator('p[data-idx]').filter({hasText: original}).first();
      await paragraph.evaluate(p => {
        p.closest('[contenteditable]').focus();
        const range = document.createRange(); range.selectNodeContents(p); range.collapse(false);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      });
      await page.keyboard.insertText(addition);
      await paragraph.filter({hasText: original + addition}).waitFor();
    }
    await appendText(FIRST_ORIGINAL, ' FIRST303');
    const editConfirmedMs = Date.now() - navigationAt;
    // beforeSave must parse/append the missing tail while retaining this edit.
    await page.evaluate(() => window.progressive.save());
    await appendText(SECOND_ORIGINAL, ' SECOND303');
    await page.evaluate(() => window.progressive.save());
    const originalZip = await JSZip.loadAsync(await (await page.request.get(url + '/original')).body());
    const savedBytes = await (await page.request.get(url + '/bytes')).body();
    const savedZip = await JSZip.loadAsync(savedBytes), reopened = await inspect(savedBytes);
    assert.ok(reopened.nodes.some(n => n.text === FIRST_ORIGINAL + ' FIRST303'));
    assert.ok(reopened.nodes.some(n => n.text === SECOND_ORIGINAL + ' SECOND303'));
    assert.ok(reopened.nodes.some(n => n.text.includes(TAIL_WITNESS)));
    for (const [name, file] of Object.entries(originalZip.files)) {
      if (file.dir || ['word/document.xml', 'docProps/core.xml'].includes(name)) continue;
      assert.deepEqual(await savedZip.file(name)?.async('uint8array'), await file.async('uint8array'), name);
    }
    // Reopen bytes through the same inspectView and full editor path.
    await page.reload(); await page.waitForFunction(() => !!window.progressive);
    await page.evaluate(() => window.progressive.ready());
    const reopenedFrame = page.frames().find(f => f.parentFrame());
    await reopenedFrame.locator('.tiptap.doc-page').filter({hasText: FIRST_ORIGINAL + ' FIRST303'}).waitFor();
    await page.evaluate(() => window.progressive.preview(true));
    assert.equal(await reopenedFrame.locator('.tiptap.doc-page').first().getAttribute('contenteditable'), 'false');
    await page.evaluate(() => window.progressive.preview(false));
    await reopenedFrame.waitForFunction(() => document.querySelector('.tiptap.doc-page')?.getAttribute('contenteditable') === 'true');
    // A fresh preview must also append validated source after the read-only
    // boundary is active. Exercise the real save/output barrier, without writing.
    await page.goto(url + '/?preview');
    await page.waitForFunction(() => !!window.progressive);
    await page.evaluate(() => window.progressive.ready());
    const previewFrame = page.frames().find(f => f.parentFrame());
    assert.equal(await previewFrame.locator('.tiptap.doc-page').first().getAttribute('contenteditable'), 'false');
    assert.ok((await previewFrame.evaluate(() => window.__projectMindDocxHost.currentContext.doc.parsed.blocks.length)) < APPENDED_BLOCKS);
    await page.evaluate(() => window.progressive.controller.beforeSave());
    await previewFrame.locator('.tiptap.doc-page').filter({hasText: TAIL_WITNESS}).waitFor();
    assert.equal(await previewFrame.locator('.tiptap.doc-page').first().getAttribute('contenteditable'), 'false');
    const slider = previewFrame.getByRole('slider', {name: '缩放比例'});
    const zoom = () => slider.inputValue().then(Number);
    const expectZoom = async expected => {
      await previewFrame.waitForFunction(value => Number(document.querySelector('.zoom-slider').value) === value, expected);
    };
    await slider.focus(); await slider.press('Home'); await expectZoom(50);
    assert.equal(await previewFrame.getByRole('button', {name: '缩小', exact: true}).isDisabled(), true);
    await previewFrame.getByRole('button', {name: '放大', exact: true}).click(); await expectZoom(60);
    await slider.focus(); await slider.press('End'); await expectZoom(150);
    assert.equal(await previewFrame.getByRole('button', {name: '放大', exact: true}).isDisabled(), true);
    await previewFrame.getByRole('button', {name: '缩小', exact: true}).click(); await expectZoom(140);
    async function dialogZoom(value) {
      await previewFrame.getByRole('button', {name: '缩放百分比', exact: true}).click();
      const dialog = previewFrame.locator('.zoom-dialog');
      if (typeof value === 'number') await dialog.getByRole('spinbutton').fill(String(value));
      else await dialog.getByRole('radio', {name: value, exact: true}).check();
      await dialog.getByRole('button', {name: '确定', exact: true}).click();
      await dialog.waitFor({state: 'hidden'});
    }
    await dialogZoom(-10); await expectZoom(50);
    await dialogZoom(500); await expectZoom(150);
    for (const value of ['150%', '100%', '75%']) { await dialogZoom(value); await expectZoom(Number.parseInt(value)); }
    for (const value of ['页宽', '文字宽度', '整页', '多页']) {
      await dialogZoom(value); assert.ok(await zoom() >= 50 && await zoom() <= 150, value);
    }
    // Dispatch to the actual installed non-passive wheel handler, including its
    // fractional Ctrl-wheel pinch path. This is not an OS gesture claim.
    async function wheel(deltaY, deltaMode, count) {
      await previewFrame.locator('.editor-scroll').evaluate((node, args) => {
        for (let i = 0; i < args.count; i++) node.dispatchEvent(new WheelEvent('wheel', {bubbles: true, cancelable: true, ctrlKey: true, deltaY: args.deltaY, deltaMode: args.deltaMode}));
      }, {deltaY, deltaMode, count});
    }
    await wheel(-1, 1, 20); await expectZoom(150);
    await wheel(1, 1, 20); await expectZoom(50);
    await wheel(-0.5, 0, 400); await expectZoom(150);
    await wheel(0.5, 0, 400); await expectZoom(50);
    await page.setViewportSize({width: 440, height: 350}); await dialogZoom('整页'); await expectZoom(50);
    await page.setViewportSize({width: 2200, height: 1400}); await dialogZoom('页宽');
    assert.ok(await zoom() >= 50 && await zoom() <= 150);
    assert.deepEqual(await page.evaluate(() => window.progressive.errors), []);
    assert.deepEqual(errors, []);
    results.push({browser: kind, mode: 'headless desktop browser, real renderer/engine, no Tauri/native IPC',
      firstContentMs: initial.firstContent - navigationAt, firstEditableMs: initial.firstEditable - navigationAt,
      editConfirmedMs, loadedBlocksAtFirstEditable: initial.blocks, appendedFixtureBlocks: APPENDED_BLOCKS,
      twoSavesReopen: true, untouchedEntriesEqual: true, previewEdit: true, initialPreviewTail: true, zoomBounds: [50, 150],
      zoomPaths: ['slider keyboard', 'step buttons', 'dialog percent clamp', 'dialog presets', 'four fit modes', 'Ctrl-wheel notch', 'fractional Ctrl-wheel pinch', 'viewport resize'], errors});
  } finally { await browser.close(); }
}
await writeFile(new URL('output/browser/progressive-results.json', import.meta.url), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
