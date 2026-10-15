# #124 WP4 交接

## 范围与来源

基线 91b35def；依赖 WP1 bound File/Version 服务、WP2 主内容壳。交付六格式预览、固定版本读取、定位/视图与来源回调、资源生命周期。Office 编辑、Session/模型、主 App/store/FilePreviewWorkspace/WP5 adapter 非目标；未改这些范围，未 stage/commit，未使用 GUI 或 review 子 agent。

真实来源：DSH `639ed015397290b3745d163aafe02ffee4aa3f84` / `dsh-v0.2.0-rc.2`；archive SHA-256 `c126f2f5dc56820e62d07e52eba6455cc20fffb379fc876626993452d86d4010`。所选 ui-sidebar-documentpreview 正文、缩放、静态 HTML 和 PDF Worker 生命周期源码正式纳入构建。provenance 逐文件记录原始/当前哈希与本地修改；MIT、第三方以及 PDF binary 许可清单完整。PDF.js 使用现有锁定 6.2.108（上游要求 6.3.289，明确主机适配），DOMPurify 3.4.11 是唯一新增根依赖，已告知主 agent。

## 主壳组件契约

```ts
ProjectFileContent({
  workspaceRoot: string, projectId: number, fileId: number,
  versionNumber?: number, line?: number, page?: number,
  initialView?: {scrollTop?: number, zoom?: number},
  initialSourceMode?: boolean,
  visible: boolean, focused: boolean,
  onViewChange?: (partialView: {
    versionNumber?: number, line?: number, page?: number,
    scrollTop?: number, zoom?: number, sourceMode?: boolean
  }) => void,
  onSourceReady?: (source: AgentSourceRef | null) => void
})
```

`versionNumber:undefined` 表示 latest 查看状态，实际读到的版本独立固定。主壳按 File + 实际查看版本保存视图，在首次装载或版本切换传入 initialView；zoom=0 表示 fit-width，其余是 scale。文本/代码/Markdown/图片/PDF 挂载时恢复，异步布局增长后继续恢复滚动落点，用户输入后停止恢复；滚动/缩放变化由 onViewChange 回传，驻留组件也按版本保存。显式 line 优先定位；PDF 有保存 scrollTop 时恢复页内偏移，无 scrollTop 时按 page 等待首/目标页渲染后定位。initialView 可以在 sourceReady 确认 actual version 的同 render 或后 render 到达，一次恢复后不因后续保存 props 更新反复拉回。主壳保留 visited File 挂载；仅静态 HTML 在隐藏期间保留 renderer，其他正文清空释放。

`initialSourceMode?:boolean` 恢复 HTML/Markdown 源码模式，显式 props 变化同步模式；按钮通过 `onViewChange({sourceMode:boolean})` 回传主 store。刷新/版本读取不重置模式；模式切换不额外读取字节。主已加 sourceLocator 和页内范围提示保持原样，版本选择仍清除旧定位。

onSourceReady 在读取开始、刷新、切版本、隐藏/卸载先 null；完成真实 readBytes object/version/hash/length 及相关读取校验后提供 `{object: bytes.object, revision: bytes.contentHash, fileVersion: bytes.versionNumber, recordVersion:null,blockId:null,locator:null,title:bytes.name,excerpt:""}`。unsupported 有固定 bytes 也提供。错误/迟到请求不会发布；引用 UI 使用此已加载 source，不再在点击时 resolve live 推算。

## 原生接口最终确认

```ts
projectFileApi.resolve(binding, object): Promise<ProjectDirectoryFile>
projectFileApi.resolveRelated(binding, object, relativeReference: string): Promise<ProjectDirectoryFile>
projectFileApi.readBytes(binding, {
  object, versionNumber, expectedContentHash
}): Promise<{object,versionNumber,contentHash,name,mime,byteLength,base64}>
```

ProjectDirectoryFile 为 `{object,relativePath,name,versionNumber,contentHash,state,reason}`。每个命令 binding first，复用已有 native generation 校验。latest 打开/刷新先 resolve，对账 actual current version/hash；ambiguous/missing/unavailable 显示 reason 并保留历史选择。history 不依赖 live ready。resolveRelated 仅 current，从主 File 的真实 parent 映射同 Project 资源，ready/hash 后按返回身份/version/hash readBytes；固定历史禁止用 current resolver。资源读完再次对账主版本和路径；依赖 documentVersions invalidation 刷新 latest。

WP1 已落实这三个接口，无当前调用所缺 DTO。历史关联资源快照仍无原生 seam，明确限制；若要解锁历史资源，需要主版本绑定的依赖身份/版本快照解析，不能沿用 current resolver。

## 样例及验收边界

- Text：真实 DSH TextBody / Unicode 多页原文、完整复制数据、源码行定位与越界提示。
- Code：真实 Shiki CodeBody，语法 DOM、行号与定位。
- Markdown：真实 DSH table/list/raw HTML 禁止、inline/reference 同 Project PNG 原生解析、远端/历史限制，原源码保留。
- Image：真实 DSH ImageBody + 真实 PNG decoder，Blob 创建/释放、缩放恢复、Portal 释放。
- PDF：固定上游两页 PDF 原件，实际 PDF.js + native canvas 绘制文字/颜色和字体资源；DSH page/zoom 组件测试，原上游 Worker handshake/cancel/terminate 测试。
- HTML：真实 DSH BasicHtmlFrame、空 sandbox、sanitizer/CSP，bound 图片/CSS 样例、危险脚本/事件/远端资源处理，同一固定文本直接传 DSH TextBody，精确源码行定位，不追加 FileHtmlPreview 服务读取。

这些是实际 renderer/fixture 与服务 mock 的组件测试；未运行 GUI、native IPC 与主壳端到端平台验收。#115 交互执行未实现；静态 HTML 不宣称交互隔离完成。复杂 CSS 依赖/srcset 明确不支持；HTML 源码行定位、滚动恢复现已接入 DSH TextBody；空 sandbox 静态 iframe 内部滚动仍无法回传/恢复。历史关联资源未保留。A17–A23/A28 在这些自动验证范围内推进，不代表全部 A01–A32 或 Issue 已完成。

## 验证

2026-10-11 最终有效证据：

| 验证 | 结果 / 日志 |
| --- | --- |
| `npm run test:unit -- src/components/document/ProjectFileContent.test.tsx packages/dsh-ui/preview/renderers.test.tsx packages/dsh-ui/preview/pdf-real.node.test.ts packages/dsh-ui/preview/pdf-runtime.test.ts --maxWorkers=1` | 44/44，`$TMPDIR/mind-wp4-final-tests.log`；随后针对异步布局恢复改动重跑受影响两文件 31/31（含新增一例），`$TMPDIR/mind-wp4-view-final.log`。未变的实际 PDF / Worker 14 项复用前次通过证据；最终共 45 个用例有效 |
| `node --test packages/dsh-ui/vendor-integrity.test.mjs packages/dsh-ui/preview/assets-integrity.test.mjs` | 4/4，`$TMPDIR/mind-wp4-final-integrity.log`；逐源码/hash、alias、scoped CSS、完整 PDF binary/license |
| `npm --prefix packages/dsh-ui run check:source` | 982 modules，`$TMPDIR/mind-wp4-final-source.log` |
| `npm --prefix packages/dsh-ui run check:adapters` | 989 modules，`$TMPDIR/mind-wp4-final-adapters.log`；无 ModuleLoader / 未解析 browser import |
| `npx tsc --noEmit` | 通过，`$TMPDIR/mind-wp4-final-tsc.log` 空输出 |
| `git diff --check`（本包路径） | 通过 |

未运行全量应用测试、GUI 或本包 native 集成测试。主 agent 必须接主壳 SourceRef 缓存及视图；测试不等同于产品全部 A01–A32 验收。

## 本次补齐（2026-10-11）

- HTML source=true 改用 DSH TextBody + 已校验 fixed text/line。当时未修改旧 FileHtmlPreview；2026-10-14 生产引用检查确认它已无调用，随旧预览界面移除。移除本包旧 HTML 专用 CSS 隐藏规则。
- actual-version initialView 可在 sourceReady 后到达；主壳式 callback/render、各版本视图与隐藏卸载样例通过。一次恢复后用户滚动不会被后续保存 props 拉回。
- PDF 恢复 zoom（含 0 fit-width）、page 与 saved scroll；首/目标页面异步尺寸落定后再次定位，卸载重建后保持。
- SourceRef 成功/清空/迟到隔离旧验证继续有效；新增 bytes hash 不符始终 null 验证。
- 空 sandbox 原 DSH BasicHtmlFrame 为 opaque origin，host 不可访问 document/scrollY/scrollTo；postMessage 无可执行接收方（脚本仍禁用）。保留实际限制，未加入 allow-same-origin / allow-scripts 或修改 CSP。依据 [HTML sandbox flag](https://html.spec.whatwg.org/multipage/browsers.html#sandboxed-origin-browsing-context-flag) 与 [CrossOriginProperties](https://html.spec.whatwg.org/multipage/nav-history-apis.html#crossoriginproperties-(o))。本次未运行 GUI，不能以 DOM mock 宣称原生平台已验收。

针对性新证据：组件受影响过滤 7/7（`$TMPDIR/mind-wp4-followup-content2.log`），PDF/定位/异步布局及预加载回调页码漂移过滤 7/7（`$TMPDIR/mind-wp4-followup-renderers3.log`）。未重复运行未变化 45 项整组；其他既有验证在未变化范围复用。最终 `npx tsc --noEmit` 通过（`$TMPDIR/mind-wp4-followup-tsc.log`），`check:adapters` 990 modules 通过（`$TMPDIR/mind-wp4-followup-build.log`）。portable-paths 本包新增项为零；当时全仓仍报接收基线已有的旧 DSH docs 14 项 baseline（`$TMPDIR/mind-wp4-followup-portable.log`），主 agent 另处理。diff whitespace 检查通过。

## A05 visited HTML 跟进（2026-10-12）

- 隐藏 Tab/跨 Project：取消进行中的异步读取，sourceReady 始终 null；只有静态 HTML 保留 immutable Loaded 和原 renderer/iframe/browsing context。HTML 源码及其他格式清 Loaded，图片 Blob 和 Portal 释放。
- 再可见先 bound resolve/版本读取和相关资源重读。旧静态 frame 可在校验期间保留；发现版本/hash 变化立即淘汰，读取错误也淘汰，不把旧内容作为成功结果或引用。切版本、关闭和迟到响应不会复活旧 frame。
- 复用条件包含 `prepareStaticHtml` 后的真实 displayBytes 长度和每一个字节相等，不能只凭 rootVersion/hash。相同最终内容保留旧 bytes 引用及 rendererId，srcDoc 不重新赋值；关联 CSS/图片导致最终字节变化时新 renderer 淘汰旧 iframe，即便主 File 版本未变。
- 空 sandbox、固定 sanitizer/CSP 和交互开关保持不变。隐藏恢复依靠原 browsing context 保留内部位置，不通过 parent DOM/scroll API 绕过隔离。关闭重开、模式切换、内容更新或重启会创建新 frame，其内部滚动仍不能持久恢复。
- `initialSourceMode` / `ProjectFileView.sourceMode` 契约已交主 agent；主 store、ContentView/Page visited 生命周期和 final build/package 由主 agent 整合。

针对性验证：既有受影响过滤 **10/10**（`$TMPDIR/mind-wp4-a05-existing2.log`），新增 **9/9**（`$TMPDIR/mind-wp4-a05-new2.log`），包括跨 Project 两个独立 frame、同内容无 srcDoc 属性改写、关联资源变化替换 frame、错误/迟到淘汰、源码模式及非 HTML Blob 释放。`npx tsc --noEmit` 通过（`$TMPDIR/mind-wp4-a05-tsc.log`）。未重跑未变化全组，未 GUI；这些 DOM 生命周期测试不代替 macOS WebView 内部滚动的真实验收。源码修改在此停止，等待主集中构建包装。

## 修改文件清单

- 新 `src/components/document/ProjectFileContent.tsx`、`ProjectFileContent.test.tsx`、`project-file-content.css`。
- 新 `packages/dsh-ui/preview/`：index JSX/types、preview CSS、resources/static-html adapter 与 types；renderer/real PDF/原 Worker lifecycle/asset integrity tests；原 PDF fixture；PDF assets generator/正式 binary map/逐源 provenance；11 项许可文件；README/HANDOVER。
- 新固定 `packages/dsh-ui/upstream/client/ui-sidebar-documentpreview/` 所选源码和原 package manifest，逐文件见 `packages/dsh-ui/provenance.json`。
- 增量改 `packages/dsh-ui/{README.md,package.json,provenance.json,verify-build.mjs}`，主 `package.json/package-lock.json` 仅增加 DOMPurify 3.4.11。


主侧后续将相关 DSH 文档日志路径改为 `$TMPDIR`、仓库路径改为 `$REPO_ROOT`；全仓 `check:portable-paths` 已通过。
