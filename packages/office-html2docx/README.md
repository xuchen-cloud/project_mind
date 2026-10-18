# Browser HTML → DOCX helper

Issue #191 的独立浏览器包。复用完整、未修改的 GenOffice HTML 转换闭包，提供 Word `onConvertAltChunkHtml` 回调：

```ts
import { convertAltChunkHtml } from './dist/index.mjs';
const bytes = await convertAltChunkHtml(html, { signal });
```

返回 `Uint8Array`；清洗后没有可转换内容时返回 `null`。解析、图片、截图、预算和取消错误均拒绝 Promise。每次调用拥有独立离屏 iframe，结束或取消时销毁。

## Build

在本包目录使用 Node 24：

```sh
npm ci
npm run build
npm run typecheck
npm test
```

`build` 校验/补齐 `source-lock.json` 固定的 31 个上游文件，输出：

- `dist/index.mjs`：浏览器 ESM，运行时不依赖 Electron、Node 或 Playwright。
- `dist/index.d.mts`：与 `types.ts` 一致的声明，供路径动态 import 使用。
- `dist/source-lock.json`、`dist/index.meta.json`、`dist/THIRD-PARTY-NOTICES.txt`：来源、构建闭包和完整许可。

初次构建需要获取锁定的 GitHub raw 源码；已存在且哈希正确时不联网。可用 `node prepare-source.mjs --source /path/to/genoffice` 从本地上游快照补齐，或 `--verify-only` 检查已有源码。依赖仅由本包 `package-lock.json` 固定；宿主消费 bundle，无需 Word 新增依赖。

测试默认使用 `playwright-core` 启动本机 Chrome 的 headless 模式。可复用宿主已安装的 Playwright 和 WebKit，不下载浏览器：

```sh
OFFICE_BROWSER=webkit \
OFFICE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
OFFICE_WEBKIT_EXECUTABLE=/absolute/path/to/webkit/pw_run.sh \
node --test test/browser.test.mjs
```

支持 `OFFICE_BROWSER=chromium|webkit`。省略 module/executable 时使用包内 runner 和其已有缓存。测试启动临时 localhost harness，并在结束时关闭。产物按浏览器保存在忽略的 `test/output/chromium/` 与 `test/output/webkit/`，包括真实 DOCX、裁剪 PNG 和浏览器版本记录。`OFFICE_BROWSER_DEBUG=1` 额外记录浏览器 console 与截图 SVG，供失败诊断。

安全边界、资源限制与实测范围见 [实现记录](../../docs/implementation/genoffice-altchunk.md)。
