# Word / PowerPoint 连续保存接入

关联 #118、#191 的当前内容保存与版本拆分工作。依赖统一 FileEditSession 保持初始 model、累计 edits、按 renderer editRevision 确认保存，保存期间保持可编辑。交付为 DOCX / PPTX 完整 renderer 的快照序号与回执；不修改原生 CAS、历史归档或 XLSX。

## 接口与真实入口

- `DocxEditor` 实际加载 `dist/full-editor.mjs`，进入 `mountFullEditorSource` 和 `renderer-host.ts`。`onChange(edits, {editRevision})` 传递生成 snapshot 的文档 revision；`savedEditRevision` 经 settings/update 仅推进 persistedRevision。累计 snapshot 保留原 baselineHash；回执不清空 snapshot，不调用 setContent，不改变 iframe 或当前 selection controller。
- `PptxEditor` 实际加载 `dist/renderer.html`，进入 `parity-entry.tsx` 和完整 vendor App。candidate 输出当前 dirtyVersion；重复 flush 由 snapshotVersion 去重。回执通过独立 saved-revision 消息传递，不 init、不重新解析归档、不更新 candidate baseline、不销毁 session。
- 原样累计 edits 回显分别由 DOCX lastEmitted 与 PPTX samePptxEdits 识别，避免外部替换路径。model 更换仍属于真实替换语义。
- PPT 手动保存原 vendor file-actions 无条件清 dirty。构建适配将其改为采用回执 hasLaterEdits；晚到 mutation、尚未提交文本或 IME 仍为 dirty。回执不返回 slides，因此不会进入 adoptSavedSlides 的 selection remap。is-dirty 查询采用当前编辑序号与已确认序号，避免累计 engine dirty 错报。

## 针对性验证

- `node --test packages/office-docx/test/renderer-host-scheduling.test.mjs`：10 项通过，新增两次内容快照、旧回执保留 dirty、新回执确认、重复 flush 不生成序号且保留累计字节；既有 IME/异步粘贴/并发 flush 通过。
- `npm run test:ui --prefix packages/office-pptx -- test/editor.test.tsx`：25 项通过，新增两次累计编辑和回执不重新 init、序号透传。
- `node --test packages/office-pptx/test/save-receipt.test.mjs`：真实 vendor file-actions 经实际构建适配后执行，保存挂起时晚到编辑保留 dirty，第二次成功才清 dirty。
- `npm run check --prefix packages/office-pptx` 通过；两格式局部 build 通过。

后续已补齐两格式 `test/browser-continuous-save.mjs`：Chromium、WebKit 的真实完整 renderer 均通过延迟保存期间继续输入、旧回执保留焦点/caret及后续 dirty、第二次保存包含全部输入、跨保存 undo。每个候选实际序列化并重新 inspect，pageerror 为空。未启动原生应用或窗口；此验证不等同于 macOS 原生应用或 Windows 产品验收。

## 父级当前内容与 Markdown 接入

`ProjectFileContent` 对当前 Office / Markdown 调用 `fileWorkingApi.open`，以原生 current bytes/model 建立会话，保留旧 baseline 字段仅供历史读取；当前内容不再与最后归档版本 hash 强行相等。父组件拥有 session 的打开与关闭，隐藏/显示、保存回执、同内容的 metadata tick 不重开；替换/卸载释放 session，不归档。卸载 close 失败通过全局错误 toast 报告。历史版本继续走旧固定版本读取且只读，加载期间也不将未归档 working bytes 当作同号 vN 展示。

版本菜单当前行与工作内容按钮显示“当前内容”，归档 vN 保持独立可选。native invalidation 对当前 working 执行 tick：相同 revision/hash 仅更新归档元数据与历史菜单，真实内容变化在干净编辑器重新加载；脏编辑器保留原 session，后续保存 CAS 报告冲突。own-write 事件可能早于 save Promise 回执，不能将脏编辑器的 revision 差异直接误报为外部修改。

Markdown 改用统一 `FileEditSession`；初始 text/model 与 documentKey 保持，累计 source 生成保存候选。保存期间继续输入，回执只确认当时 edits，晚到编辑继续 dirty；撤销回原文的空 edits 仍保存原始字节。手动保存不强制只读，父级 flush 排空晚到编辑后才允许离开。输入、IME 活动上报 native activity；失败显示错误。Markdown 回调统一为 `onSaved(version, hash, working?, text?)`。

未归档 current hash 不会与旧 archivedVersionNumber 拼接成 AgentSourceRef。只有无待归档状态且该归档 hash 与 working hash 相等时才发布固定 source；归档完成通过 metadata tick 重新确认。初始 Markdown 图片异步读取验证真实 working revision/hash，外部变化和已卸载文档不混入结果；路径、同项目归属及资源预算沿用既有边界。

验证：`npx vitest run src/components/document/{ProjectFileContent,ProjectFileLoading,ProjectFileOffice,ProjectFileMarkdown,MarkdownFileContent,FileVersionMenu}.test.tsx --maxWorkers=1`，6 文件 127 项通过；新覆盖 current/hash 独立、会话隐藏保留、own invalidation、归档菜单更新、current/history 字节隔离、连续保存/caret/晚到中文输入、撤销回原文与精确失败请求重放。`npx tsc --noEmit --pretty false` 通过。无原生应用窗口，真实产品验收仍需主工作包集中执行。
