/**
 * Issue #213: assistant Markdown links/tables against the real host CSS cascade.
 * Run: node packages/dsh-ui/markdown-link-layout.browser.mjs [--baseline]
 * OFFICE_PLAYWRIGHT_MODULE may point to an installed @playwright/test/index.mjs.
 * No CSS fixes or component mocks: generated fixtures/artifacts stay in output/.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(root, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const playwrightPath = process.env.OFFICE_PLAYWRIGHT_MODULE
  ?? resolve(root, 'packages/office-xlsx/node_modules/@playwright/test/index.mjs');
const { chromium, webkit } = await import(pathToFileURL(resolve(playwrightPath)).href);
const output = resolve(root, 'output/playwright/markdown-link-layout');
await mkdir(output, { recursive: true });
await writeFile(resolve(output, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
const cases = [
  { id: 'file-skill', text: '[SKILL.md](/workspace/SKILL.md)', plain: 'SKILL.md', file: { path: '/workspace/SKILL.md' } },
  { id: 'file-todo', text: '[todo.md](docs/todo.md#L7-L9)', plain: 'todo.md', file: { path: 'docs/todo.md', line: 7 } },
  { id: 'mention-skill', text: '`SKILL.md`', plain: '`SKILL.md`', file: { path: '/workspace/SKILL.md' } },
  { id: 'mention-todo', text: '`todo.md`', plain: '`todo.md`', file: { path: '/workspace/todo.md' } },
  { id: 'http', text: '[参考文档](https://example.test/docs)', plain: '参考文档', external: 'https://example.test/docs' },
];
const tables = [
  { id: 'prose', text: '| 文件 | 当前职责 | 本次调整 | 验收结果 |\n| --- | --- | --- | --- |\n| SKILL.md | 保存会话助手的工作方法与执行说明，帮助后续任务使用项目已有的约定 | 整理本次工作所需的说明和操作步骤，保持原有职责与内容归属清晰 | 通过浏览器检查链接与文字的布局，并确认内容可以在表格中自然换行 |\n| todo.md | 记录当前任务和下一步需要处理的事项 | 完成后更新任务状态并补充验证结果 | 表格在空间足够时完整展示 |' },
  { id: 'code', text: '| 文件 | 标识 | 状态 | 说明 |\n| --- | --- | --- | --- |\n| todo.md | `build_20261023_0123456789abcdef01234567` | 已完成 | 不可压缩的代码标识 |' },
  { id: 'compact', text: '| 文件 | 类型 | 状态 | 结果 |\n| --- | --- | --- | --- |\n| todo.md | 文档 | 完成 | 通过 |' },
];
await writeFile(resolve(output, 'fixture.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/app.css';
import '/packages/dsh-ui/styles/scoped.css';
import '/packages/dsh-ui/adapters/host.css';
import { MarkdownText } from '/packages/dsh-ui/upstream/client/ui-primitives/src/markdown/MarkdownText.tsx';
import { MarkdownDelegateProvider } from '/packages/dsh-ui/upstream/client/ui-primitives/src/markdown/MarkdownDelegate.tsx';
import chatCss from '/packages/dsh-ui/upstream/client/ui-chat/src/client/chat/ChatView.module.css';
import assistantCss from '/packages/dsh-ui/upstream/client/ui-chat/src/client/chat/AssistantMarkdown.module.css';
const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' };
const cases = ${JSON.stringify(cases)};
const tables = ${JSON.stringify(tables)};
window.delegations = [];
const mentions = { resolve(value) {
  if (value !== 'SKILL.md' && value !== 'todo.md') return undefined;
  return { label: 'Open ' + value, title: '/workspace/' + value,
    open: () => window.delegations.push({ path: '/workspace/' + value }) };
} };
const dark = new URLSearchParams(location.search).get('theme') === 'dark';
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
document.body.toggleAttribute('data-ds-dark-theme', dark);
createRoot(document.getElementById('root')).render(
  <main className="dsh-ui-host" data-ds-dark-theme={dark ? '' : undefined}
    style={{height: 'auto', background: 'var(--dsw-alias-bg-base)', '--dsh-chat-content-width': '748px', '--dsh-composer-side-clearance': '8px'}}>
    <div data-chat-scroll className={chatCss.scroll}><div className={chatCss.column}>
    <div className={assistantCss.root}><div className={assistantCss.body}>
    <MarkdownDelegateProvider
      openFile={(path, options) => window.delegations.push({path, ...options})}
      openExternalLink={external => window.delegations.push({external})}>
      {cases.map(item => <section key={item.id} data-case={item.id} style={{paddingBottom: 16}}>
        <div data-subject><MarkdownText labels={labels} fileMentions={mentions} text={'请看 ' + item.text + '。'} /></div>
        <div data-control><MarkdownText labels={labels} text={'请看 ' + item.plain + '。'} /></div>
      </section>)}
      {tables.map(item => <section key={item.id} data-table={item.id}>
        <MarkdownText labels={labels} text={item.text} />
      </section>)}
    </MarkdownDelegateProvider>
    </div></div></div></div>
  </main>
);
`);

const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  cacheDir: resolve(output, '.vite'),
  optimizeDeps: { entries: [resolve(output, 'index.html')] },
  server: { host: '127.0.0.1', port: 0, strictPort: false, open: false, hmr: false, watch: null },
});
const results = [];
const failures = [];
// Collect assertions so one broken link cannot hide other browsers/scenarios.
function check(label, assertion) {
  try { assertion(); } catch (error) { failures.push(`${label}: ${error.message}`); }
}
try {
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/output/playwright/markdown-link-layout/index.html`;
  for (const [name, engine] of (process.argv.includes('--baseline') ? [['chromium', chromium]] : [['chromium', chromium], ['webkit', webkit]])) {
    let browser;
    try {
      try {
        browser = await engine.launch({ headless: true, ...(name === 'chromium' ? { channel: 'chrome' } : {}) });
      } catch (error) {
        if (name !== 'chromium' || !/not found|doesn't exist/i.test(error.message)) throw error;
        console.log('Chrome unavailable; using bundled headless Chromium.');
        browser = await engine.launch({ headless: true });
      }
      const sizes = process.argv.includes('--baseline') ? [['wide', 1200]] : [['wide', 1200], ['narrow', 360]];
      const themes = process.argv.includes('--baseline') ? ['light'] : ['light', 'dark'];
      for (const [size, width] of sizes) for (const theme of themes) {
        const label = `${name}-${size}-${theme}`;
        const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme: theme });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const result = { label, errors: [], measurements: [] };
          results.push(result);
          let rejectLoading;
          const loadingError = new Promise((_, reject) => { rejectLoading = reject; });
          const failLoading = message => {
            result.errors.push(message);
            console.error(`${label}: ${message}`);
            rejectLoading(new Error(message));
          };
          page.on('pageerror', error => failLoading(`pageerror: ${error.message}`));
          page.on('response', response => {
            if (response.status() >= 400) failLoading(`HTTP ${response.status()}: ${response.url()}`);
          });
          page.on('requestfailed', request => failLoading(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
          page.on('console', message => {
            if (message.type() === 'error') { result.errors.push(message.text()); console.error(`${label}: ${message.text()}`); }
          });
          await Promise.race([loadingError, (async () => {
            await page.goto(`${url}?theme=${theme}`);
            await page.locator('[data-case="http"] a svg').waitFor();
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
          })()]);
          result.measurements = await page.evaluate(() => {
            const rect = box => ({ x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom });
            return [...document.querySelectorAll('[data-case]')].map(section => {
              const subject = section.querySelector('[data-subject]');
              const link = subject.querySelector('button, a');
              const svg = link.querySelector('svg');
              const text = [...link.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
              const range = document.createRange();
              range.selectNodeContents(text);
              const paragraph = subject.querySelector('p');
              const control = section.querySelector('[data-control] p');
              return {
                case: section.dataset.case, tag: link.tagName, code: link.parentElement.tagName === 'CODE',
                icon: rect(svg.getBoundingClientRect()), text: rect(range.getClientRects()[0]),
                display: getComputedStyle(svg).display,
                paragraphHeight: paragraph.getBoundingClientRect().height, controlHeight: control.getBoundingClientRect().height,
                lineHeight: getComputedStyle(paragraph).lineHeight, controlLineHeight: getComputedStyle(control).lineHeight,
                textColor: getComputedStyle(paragraph).color,
                overflows: [document.documentElement, document.body, document.querySelector('main'), section, subject, paragraph, link]
                  .map(node => ({ tag: node.tagName, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })),
              };
            });
          });
          for (const item of result.measurements) {
            check(`${label}/${item.case}`, () => {
              assert.ok(item.icon.width > 0 && item.icon.height > 0 && item.text.width > 0, 'visible icon and text');
              assert.ok(item.icon.right <= item.text.x + 1, `icon must precede text: ${JSON.stringify(item)}`);
              assert.ok(item.icon.y < item.text.bottom && item.icon.bottom > item.text.y, `icon and text must share a line: ${JSON.stringify(item)}`);
              assert.equal(item.lineHeight, item.controlLineHeight, 'body line height matches plain control');
              assert.ok(item.paragraphHeight <= item.controlHeight + 1, `paragraph grew: ${item.paragraphHeight}px vs control ${item.controlHeight}px`);
              assert.equal(item.tag, item.case === 'http' ? 'A' : 'BUTTON');
              assert.equal(item.code, item.case.startsWith('mention-'));
              for (const box of item.overflows) assert.ok(box.scrollWidth <= box.clientWidth + 1, `horizontal overflow: ${JSON.stringify(box)}`);
            });
          }
          for (const item of cases) {
            await page.locator(`[data-case="${item.id}"] [data-subject] ${item.file ? 'button' : 'a'}`).click();
          }
          result.delegations = await page.evaluate(() => window.delegations);
          check(`${label}/delegations`, () => assert.deepEqual(result.delegations, cases.map(item => item.file ?? { external: item.external })));
          check(`${label}/page-errors`, () => assert.deepEqual(result.errors, []));
          result.tables = [];
          for (const item of tables) {
            const wrapper = page.locator(`[data-table="${item.id}"] .md-table-wide`);
            await page.mouse.move(0, 0);
            const measure = () => wrapper.evaluate(node => {
              const table = node.querySelector('table');
              const style = getComputedStyle(node);
              const rect = element => {
                const box = element.getBoundingClientRect();
                return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right };
              };
              return {
                wrapper: rect(node), table: rect(table), scroll: rect(document.querySelector('[data-chat-scroll]')),
                clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
                overflowX: style.overflowX, paddingBottom: style.paddingBottom,
                scrollbarHeight: node.offsetHeight - node.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
                rowHeight: table.querySelector('tbody tr').getBoundingClientRect().height,
                lineHeight: getComputedStyle(table.querySelector('td')).lineHeight,
              };
            });
            const before = await measure();
            await wrapper.hover();
            const hover = await measure();
            await wrapper.evaluate(node => { node.scrollLeft = node.scrollWidth; });
            const scrollLeft = await wrapper.evaluate(node => node.scrollLeft);
            await wrapper.evaluate(node => { node.scrollLeft = 0; });
            result.tables.push({ case: item.id, before, hover, scrollLeft });
            console.log(`${label}/table/${item.id}: ${JSON.stringify(result.tables.at(-1))}`);
            check(`${label}/table/${item.id}`, () => {
              const overflow = hover.scrollWidth > hover.clientWidth + 1;
              if (size === 'wide') assert.equal(overflow, false, 'four columns must fit available wide transcript space');
              else assert.equal(overflow, true, 'four minimum-width columns must overflow the narrow transcript');
              if (!overflow) {
                assert.notEqual(hover.overflowX, 'scroll', 'no forced horizontal scrollbar on hover without overflow');
                assert.equal(hover.scrollbarHeight, 0, 'no horizontal scrollbar gutter without overflow');
                assert.equal(scrollLeft, 0, 'fitting table cannot scroll horizontally');
                assert.ok(Math.abs(hover.wrapper.height - before.wrapper.height) <= 1, 'hover must not resize a fitting table');
              } else {
                assert.ok(['auto', 'scroll'].includes(before.overflowX), 'overflowing table is scrollable before hover');
                assert.ok(['auto', 'scroll'].includes(hover.overflowX), 'overflowing table is scrollable');
                assert.ok(scrollLeft > 0, 'overflowing table actually scrolls');
              }
              assert.ok(hover.wrapper.x >= hover.scroll.x - 1 && hover.wrapper.right <= hover.scroll.right + 1, 'breakout stays inside transcript');
              if (item.id === 'prose' && size === 'wide') assert.ok(hover.rowHeight > parseFloat(hover.lineHeight) * 2, 'prose actually wraps');
            });
          }
          await page.screenshot({ path: resolve(output, `${label}.png`), fullPage: true });
          console.log(JSON.stringify(result));
        } finally {
          await context.close();
        }
      }
    } catch (error) {
      failures.push(`${name}: ${error.stack}`);
      console.error(`${name}: ${error.message}`);
    } finally {
      await browser?.close();
    }
  }
} finally {
  await writeFile(resolve(output, 'measurements.json'), JSON.stringify(results, null, 2));
  await server.close();
}
assert.deepEqual(failures, [], failures.join('\n'));
console.log(`PASS: ${results.length} scenarios, ${results.length * cases.length} links, ${results.length * tables.length} tables; geometry, line height, overflow, hover and delegation.`);
