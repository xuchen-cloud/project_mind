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

验收包含只编辑首屏、连续两次保存再重开、从未访问的尾部、跨 sheet 公式、media/关系和未修改 parts 的保真；三格式缩放全部入口统一为 50%–150%。Windows release 实机是独立必需证据，macOS debug/浏览器结果不能替代。实际验证结果随 Issue 与 PR 记录。
