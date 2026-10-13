// F03 validation harness. SDK edits and Office export are separate from Mind commits.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverDocsCorePreset } from '@univerjs/preset-docs-core';
import { UniverDocsDrawingPreset } from '@univerjs/preset-docs-drawing';
import DocsDrawingZH from '@univerjs/preset-docs-drawing/locales/zh-CN';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import DocsZH from '@univerjs/preset-docs-core/locales/zh-CN';
import SheetsZH from '@univerjs/preset-sheets-core/locales/zh-CN';
import { Univer, UniverInstanceType } from '@univerjs/core';
import { FUniver } from '@univerjs/core/facade';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverUIPlugin } from '@univerjs/ui';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverDrawingPlugin } from '@univerjs/drawing';
import { UniverLicensePlugin } from '@univerjs-pro/license';
import { UniverSlidesPlugin } from '@univerjs-pro/slides';
import { UniverSlidesUIPlugin } from '@univerjs-pro/slides-ui';
import SlidesZH from '@univerjs-pro/slides/locale/zh-CN';
import SlidesUIZH from '@univerjs-pro/slides-ui/locale/zh-CN';
import DesignZH from '@univerjs/design/locale/zh-CN';
import UIZH from '@univerjs/ui/locale/zh-CN';
import '@univerjs/docs/facade';
import '@univerjs/docs-ui/facade';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-ui/facade';
import '@univerjs-pro/slides/facade';
import '@univerjs/design/lib/index.css';
import '@univerjs/ui/lib/index.css';
import '@univerjs/preset-docs-core/lib/index.css';
import '@univerjs/preset-docs-drawing/lib/index.css';
import '@univerjs/preset-sheets-core/lib/index.css';
import '@univerjs-pro/slides-ui/lib/index.css';

let root, api, active, format;
const evidence = [];
const status = document.querySelector('#status');
const record = (value) => { evidence.push(value); status.textContent = JSON.stringify(value, null, 2); };
window.officeValidation = { evidence, snapshot: () => active?.save(), api: () => api };

// React19 host creates the isolated child container used by Univer.
const editor = document.querySelector('#editor');
const hostRoot = createRoot(editor);
hostRoot.render(React.createElement('div', { id: 'sdk-child', style: { height: '100%' } }));
const childReady = new Promise(resolve => {
  const observer = new MutationObserver(() => { const node = document.querySelector('#sdk-child'); if (node) { observer.disconnect(); resolve(node); } });
  observer.observe(editor, { childList: true });
});

async function load() {
  const t = performance.now();
  try {
    format = document.querySelector('#format').value;
    const response = await fetch(`/${format}/imported-unit.json`);
    if (!response.ok) throw new Error(`Fixture unit not ready: ${response.status}`);
    const unit = await response.json();
    const container = await childReady;
    if (root) { root.dispose(); container.replaceChildren(); }
    if (format === 'pptx') {
      root = new Univer({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: mergeLocales(DesignZH, UIZH, DocsZH, SlidesZH, SlidesUIZH) } });
      root.registerPlugin(UniverRenderEnginePlugin);
      root.registerPlugin(UniverUIPlugin, { container });
      root.registerPlugin(UniverDocsPlugin);
      root.registerPlugin(UniverDocsUIPlugin);
      root.registerPlugin(UniverDrawingPlugin);
      root.registerPlugin(UniverLicensePlugin);
      root.registerPlugin(UniverSlidesPlugin);
      root.registerPlugin(UniverSlidesUIPlugin);
      api = FUniver.newAPI(root);
      active = api.createPresentation(unit);
    } else {
      const preset = format === 'xlsx' ? UniverSheetsCorePreset : UniverDocsCorePreset;
      ({ univer: root, univerAPI: api } = createUniver({ locale: LocaleType.ZH_CN, locales: { [LocaleType.ZH_CN]: mergeLocales(DocsZH, DocsDrawingZH, SheetsZH) }, presets: [preset({ container }), ...(format === 'docx' ? [UniverDocsDrawingPreset()] : [])] }));
      active = format === 'xlsx' ? api.createWorkbook(unit) : api.createDocument(unit);
    }
    window.officeValidation.format = format;
    record({ phase: 'loaded', format, loadMs: Math.round(performance.now() - t), unitId: active.getId(), before: format === 'docx' ? active.save().body.dataStream.slice(0, 100) : undefined });
  } catch (e) { record({ phase: 'error', format, name: e.name, message: e.message }); }
}
async function edit() {
  try {
    if (format === 'xlsx') {
      active.getActiveSheet().getRange('A1').setValue('浏览器编辑');
    } else if (format === 'docx') {
      if (!active.insertText(0, '浏览器编辑：')) throw new Error('Docs insertText returned false');
    } else {
      const slide = active.getSlideByIndex(0);
      const element = slide.getElements().find(e => 'getType' in e ? e.getRichText() : e.getText?.().getRichText());
      if (!element) throw new Error('No editable Slide text');
      const text = ('getType' in element ? element.getRichText() : element.getText().getRichText()).copy();
      const run = text.getParagraphs().flatMap(p => p.getTextRuns())[0];
      run.setText('浏览器编辑');
      if ('getType' in element) element.setRichText(text); else element.getText().setRichText(text);
    }
    record({ phase: 'edited', format, after: format === 'docx' ? active.save().body.dataStream.slice(0, 100) : format === 'xlsx' ? active.getActiveSheet().getRange('A1').getValue() : 'slide-command-returned' });
  } catch (e) { record({ phase: 'error', format, name: e.name, message: e.message }); }
}
async function save() {
  try {
    const response = await fetch('/validation/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, unit: active.save() }) });
    const result = await response.json();
    record({ phase: result.ok ? 'exported' : 'error', format, ...result });
  } catch (e) { record({ phase: 'error', format, name: e.name, message: e.message }); }
}
document.querySelector('#load').onclick = load;
document.querySelector('#edit').onclick = edit;
document.querySelector('#save').onclick = save;
record({ phase: 'ready', note: '需要打开受控样本；导出只是候选文件，不是主项目保存。' });
