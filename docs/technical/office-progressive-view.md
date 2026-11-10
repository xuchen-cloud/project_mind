# Office 首屏与增量读取

Issue: #303，范围 G04 / G09。

## 读取与保存的权威

File working session 的完整不可变 OOXML 基线 B 与从 B 开始累计的编辑 E 是保存输入。已加载视图不是完整文档，coverage 之外的内容不表示空白或删除。成功回执只确认被冻结的编辑 revision；之后的编辑仍保留。原生 CAS、hash、journal、原子写入和幂等回执继续生效。

完整 `engine.inspect` 供 authoring 和现有工具使用。GUI 使用 `engine.inspectView`，初始模型标记 partial coverage，并带首屏所需内容或固定源包的读取入口。DOCX 按块、PPTX 按 slide materialize；XLSX 使用原生持有的读取进程。

## XLSX 读取服务

`createViewSession(bytes, context)` 返回 `{model, read, close}`。第一次 `office.view.open` 传完整源包，之后的 `office.view.read` 只传有界请求。读取进程不允许替换源包、执行编辑或接收文件系统能力。

读取联合类型：

- `range`: sheetId 和最多 100,000 格的矩形。
- `formulas` / `outline`: 工作表 ID。
- `media`: 已声明 visualId。
- `pivot`: 已声明的 OOXML part 标识；引擎必须核对它来自原件目录。

工作模型使用固定源 hash。原生 cache key 包含 Workspace generation、File 身份、固定 hash 和 working session；历史版本使用版本号与 hash。原生读取服务沿用受限 Node 环境、进程树终止、2 个进程上限、128 MiB 基线总预算和 30 秒闲置淘汰。缓存丢失后可以从同一完整基线重建。warm working 读取只查询会话元数据，不复制恢复 BLOB。

`file_working_read_view` 只接受已授权的 working session；读取前后再次检查 session、owner 和 generation。关闭 session 终止它的读取进程；Workspace 关闭使所有 generation scope 失效。GUI 再用生命周期 epoch 拒绝晚到响应。视图读取不会改变 working revision 或编辑日志。

## 可用性与验证边界

窗口出现、首屏内容出现、首屏可编辑及全局功能就绪分别记录。全局功能必须等待实际依赖；未加载公式依赖不能当空白计算。完整包安全准入与可靠快照仍可能形成必要下限，应从首屏解析成本中分别计量。

XLSX 的依赖集合同时包含原文件公式和当前累计编辑，范围覆盖新增的编辑坐标。手动输入、粘贴或撤销改变单元格内容时，旧集合立即失效；本地计算等待新集合的实际依赖装入，驻留值包含只存在于编辑日志中的数据。每个已安装的依赖范围在下一次异步读取前立即驻留，避免加载其余范围期间的滚动淘汰。每次失效推进依赖 revision 和 native recalculation generation，旧异步读取/计算不能重新激活或覆盖新结果。完整加载后的计算继续走已有路径。

验收包含只编辑首屏、连续两次保存再重开、从未访问的尾部、跨 sheet 公式、media/关系和未修改 parts 的保真；三格式缩放全部入口统一为 50%–150%。Windows release 实机是独立必需证据，macOS debug/浏览器结果不能替代。实际验证结果随 Issue 与 PR 记录。

## 已取得的本机证据

截至 2026-11-10 的结果分开记录，不表示 Issue 已完成：

| 范围 | 证据 |
| --- | --- |
| 宿主 | 161 项 / 8 文件通过；worker 与私有读取协议 15 项通过；根 TypeScript 检查通过 |
| 原生读取 | 4 项通过，包含真实长期读取进程复用、关闭/晚到结果，以及历史与 working 读取的 generation 变化 |
| 原生格式保存 | 3 项 opt-in 回归通过，覆盖三格式真实 working 连续保存、重开、历史保留及原生 authoring 兼容 |
| DOCX | 50 项单测；Chromium/WebKit 真实编辑器只解析 64 个块即显示可编辑正文，320 个附加段落仍未访问；两次保存、重开及未修改 entries 保留 |
| XLSX | 格式层 50 项有效检查，含 100,000 行真实 native reader、尾部和跨 sheet 公式；手动新公式依赖的真实 renderer 回归继续执行 |
| PPTX | 格式层解析/编辑/保存与 UI 回归通过；真实 renderer 和全部适用缩放入口继续执行 |

DOCX 的单次无界面浏览器导航样本为 Chromium 416.7 ms、WebKit 490 ms 的可见且可编辑正文，真实键盘修改分别在 449 ms、618 ms 确认。它们包含测试 HTTP 宿主，不含原生 IPC/文件系统成本，未清系统缓存，不是 p95 或 Windows 性能结论。DOM 缩放入口和合成 wheel/pinch 已验；原生菜单快捷键、物理触控板及平台视觉验收另计。

原生广泛回归最初为 60 通过、1 个 Source 运行资源缺失导致的初始化失败、8 跳过。补齐生成资源后，该失败项单独复测通过；原始失败日志保留，不将这次运行重写为全绿。

用户已确认没有可用 Windows 机器，#303 保持开放。解锁需要可访问的 Windows release 环境及 OS/WebView2/硬件/版本记录，以同一 fixture 完成内容、编辑、保存保真和缩放验收。

## 原生界面与测量限制

`e1ed194` 的 pinned Node 24 根 TypeScript、生产 Vite、bundle 边界、测量前端及 macOS opt-in 原生构建通过。隔离的 `Office Fixture.app` 使用独立 app data 与 Workspace；CUA 实际确认了 DOCX large 正文、表格和图片。该次 G12 observer 仍收到 shell/iframe 的 `document.visibilityState=hidden`，double-RAF 超时，因此未取得可用的首屏/编辑计时或完整原生验收。原始失败保留在 `output/playwright/office-native/docx/docx-large-1.json`，检测到共用 observer 问题后未继续 XLSX/PPTX 原生样本。该构建早于 `11b773c` 的依赖驻留竞态修复，不能作为该修复的原生验收。

闭包竞态的定向回归执行真实构建适配后的 `activateFormulaClosure`，暂停第二个 range 读取并在其间模拟已缓存视口淘汰。旧 `e1ed194` 适配器返回 11 而非 18；`11b773c` 对同一交错返回 18，6 项定向回归通过。这项测试证明异步闭包驻留行为，不代替完整 renderer 或平台验收。
