import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

// Capture the actual onLoad registrations without building the renderer. These
// filters receive native filesystem paths from esbuild, unlike onResolve's
// import specifiers. Keep both namespaces' conventions separate.
async function hooks(relative) {
  const file = new URL(relative, import.meta.url);
  const source = await readFile(file, 'utf8');
  const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true);
  const registrations = [];
  const build = {onLoad(options, callback) { registrations.push({...options, callback}); }};
  const context = {build, b: build, readFile, resolve, dirname};
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'onLoad') {
      runInNewContext(node.getText(ast), context);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return registrations.filter(hook => !hook.namespace);
}

const cases = [
  ['../renderer-build.mjs', [
    'packages/office-docx/renderer.tsx', 'packages/office-docx/scroll-edges.ts',
    ...['components/PrintDialog.tsx','components/ZoomDialog.tsx','components/ProtectDialog.tsx',
      'components/PaginationPreview.tsx','system-fonts.ts','file-actions.ts','html-export.ts',
      'components/Ribbon.tsx','editor/extensions.ts','components/ribbon-tabs.tsx',
      'editor/image-drop.ts','App.tsx','parse-off-thread.ts','ai/AiPanel.tsx']
      .map(path => 'packages/office-docx/upstream/apps/docs/src/renderer/' + path),
  ]],
  ['../../office-xlsx/scripts/build-renderer.mjs', [
    'formula-stream-hold.ts','univer-sync.ts','i18n/strings.ts','i18n/locale.tsx','main.tsx',
    'App.tsx','ExcelShell.tsx','csv-export.ts','page-layout-actions.ts','PrintDialog.tsx',
    'SheetTabContextMenu.tsx','merge-workbooks.ts',
  ].map(path => 'packages/office-xlsx/vendor/apps/sheets/src/renderer/' + path)],
  ['../../office-xlsx/scripts/patch-univer.mjs', ['ui','sheets-note-ui','sheets-ui']
    .map(name => 'node_modules/@univerjs/' + name + '/lib/es/index.js')],
];

for (const [script, paths] of cases) {
  test(`${script}: native Windows and POSIX paths select the same real hooks`, async () => {
    const registrations = await hooks(script);
    const covered = new Set();
    for (const path of paths) {
      const posix = '/checkout/' + path;
      const windows = 'C:\\checkout\\' + path.replaceAll('/', '\\');
      const selected = registrations.filter(hook => hook.filter.test(posix));
      assert.equal(selected.length, 1, posix);
      assert.deepEqual(registrations.filter(hook => hook.filter.test(windows)), selected, windows);
      assert.equal(registrations.some(hook => hook.filter.test(windows + '.bak')), false);
      covered.add(selected[0]);
    }
    // The PDF worker is intentionally basename-only and has no path separators.
    assert.equal(covered.size, registrations.filter(hook => !hook.filter.test('/pdf.worker.min.mjs')).length);
  });
}

async function transformWindowsFile(t, registrations, relative, source) {
  const {mkdtemp, mkdir, writeFile, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const directory = await mkdtemp(resolve(tmpdir(), 'office-windows-hook-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  // Backslashes are legal filename characters on POSIX, so the callback reads
  // real upstream bytes while its dispatch sees the exact Windows suffix.
  const path = process.platform === 'win32'
    ? resolve(directory, ...relative.split('/'))
    : resolve(directory, 'C:\\checkout\\' + relative.replaceAll('/', '\\'));
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, source);
  const selected = registrations.filter(hook => hook.filter.test(path));
  assert.equal(selected.length, 1, path);
  return selected[0].callback({path});
}

test('Windows DOCX App dispatch executes the real save and read-only host transforms', async t => {
  const {rendererAdapter} = await import('../renderer-build.mjs');
  const registrations = [];
  rendererAdapter(fileURLToPath(new URL('../', import.meta.url))).setup({
    onLoad(options, callback) { registrations.push({...options, callback}); }, onResolve() {},
  });
  const source = await readFile(new URL('../upstream/apps/docs/src/renderer/App.tsx', import.meta.url), 'utf8');
  const result = await transformWindowsFile(t, registrations, 'apps/docs/src/renderer/App.tsx', source);
  assert.match(result.contents, /window\.__projectMindDocxHost\.requestSave\(\)/);
  assert.match(result.contents, /embeddedReadOnly \|\| writeLocked \|\|/);
});

test('Windows XLSX menu dispatch executes the real read-only permission transform', async t => {
  const source = await readFile(new URL('../../office-xlsx/vendor/apps/sheets/src/renderer/SheetTabContextMenu.tsx', import.meta.url), 'utf8');
  const result = await transformWindowsFile(t, await hooks('../../office-xlsx/scripts/build-renderer.mjs'), 'apps/sheets/src/renderer/SheetTabContextMenu.tsx', source);
  assert.match(result.contents, /const locked = protection.locked \|\| window\.__projectMindSheetsHost\.isReadOnly\(\)/);
  assert.match(result.contents, /disabled=\{options.disabled \|\|/);
});

test('Windows Univer dispatch keeps note input synchronous before saving', async t => {
  const source = await readFile(new URL('../../office-xlsx/node_modules/@univerjs/sheets-note-ui/lib/es/index.js', import.meta.url), 'utf8');
  const result = await transformWindowsFile(t, await hooks('../../office-xlsx/scripts/patch-univer.mjs'), 'node_modules/@univerjs/sheets-note-ui/lib/es/index.js', source);
  assert.match(result.contents, /const updateNote = \(\(newNote\) => \{/);
  assert.doesNotMatch(result.contents, /const updateNote = useDebounceFn/);
});
