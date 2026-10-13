# Office 首轮接入工作包

关联 Issue：#118（F04/F05/F06）；独立分支 `codex/office-integration`。

## 交付与范围

主程序按 File 身份打开 DOCX/XLSX/PPTX；支持已有内容的简单编辑、原格式保存与关闭重开。DSH 使用同一格式模块与 File 版本保存边界。Markdown、PDF、旧二进制 DOC/XLS/PPT、高级布局编辑不属于本包。

## 共用格式接口

各格式 package `packages/office-{docx,xlsx,pptx}` 自带固定来源与可重复构建。Node ESM engine 导出：

- `inspect(bytes: Uint8Array, context?): Promise<Model>`
- `edit(bytes: Uint8Array, edits: Edit[], context?): Promise<Uint8Array>`

context 仅由宿主给出 `{binaryPath?, tempRoot?}`；不接受调用方原件/目标路径。engine 不提交业务文件；格式编辑严格绑定原件，保留未编辑 OOXML 部件。Model/Edit 为各格式明确类型，格式 package 的 `types.ts` 导出。各 package 的 `dist/engine.mjs` 不依赖工作区绝对路径。

各格式 React 编辑器放在 `src/components/office/{Docx,Xlsx,Pptx}Editor.tsx`，接收 `{model, edits, onChange(edits), readOnly}`。编辑器仅产出相对当前基线的 edits；不调用保存或独立持久化。root package/lock、共用 UI/命令与部署由主 agent 负责。

## Native utility 接口

`office.inspect`：`{format, base64}` → `{model}`。
`office.edit`：`{format, base64, edits}` → `{base64, model}`。

Native GUI/DSH 文件身份接口先读取固定 File/version/hash 的原件，由 utility 生成候选，再经既有 FileContentService 提交。CAS 冲突不得覆盖；历史版本只读；失败保留编辑；成功 rebase。DSH 不创建第二套存储。

## 验收与验证范围

真实 DOCX 中文段落/表格、XLSX 值与简单公式跨表缓存、PPTX 文本修改：保存后原格式重开显示修改，多次保存保留先前修改；原件其他部件保持。真实 File 提交拒绝旧基线、归属不符；历史原件可读。主程序格式入口、只读历史与保存状态执行针对性界面/服务测试。发布前执行受影响完整验证与 Standards/Spec 主 agent 自检；#118 不因本包关闭。

## 接入方式

DOCX/PPTX 使用固定 GenOffice 公共核心；XLSX 使用其保留原件部件的 gateway/native sidecar，Univer OSS 0.25.1 仅负责表格编辑画布。通过主项目 File 页面进入，不需要 DSH 页面承载编辑器。

GUI 保存按钮、Cmd/Ctrl+S、关闭内容标签页和离开项目复用同一个 flush。Excel 先结束当前单元格输入，再取得编辑操作；未提交的单元格输入也计入未保存状态，版本通知不会替换它。保存期间锁定编辑，失败保留修改和重试身份，成功换成实际保存后的模型与版本。历史版本只读，恢复使用既有 File 恢复入口。

Office 原件由 native 格式命令直接读取固定版本，不走通用 10 MiB 预览读取，也不把原始 base64 往返传给前端。utility 只接收字节和操作；真实文件替换、回执、CAS、目录文件崩溃恢复仍由 FileContentService 处理。XLSX 私有临时候选文件只做 rename，正式文件的同步与恢复由 Rust 保存边界执行。

DSH 的 `file_office_inspect` / `file_office_edit` 使用真实 Session 与同一 native kernel。模型收到语义目标与版本，不接收图片 base64 或渲染树。用户明确当前已不用 Pi，本包不新增或维护 Pi Office 接入。

## 首轮限制

- DOCX 编辑已有正文及表格文字；不支持增删节点和完整分页排版，复杂部件保持原件。文档链接只展示，不从应用内容区执行导航。
- XLSX 编辑文本、数字、空白和简单数值公式。当前画布显示每张工作表 A1–Z100，超出范围有提示；计算限制为全工作簿 20,000 单元格，原件上限 64 MiB。图表/高级对象保存在原件中，未显示的对象有提示。共享/数组公式、保护内容和不支持的公式结果会明确拒绝。
- PPTX 编辑已有普通文字运行和顶层图片位置；保留幻灯片顺序、未改部件和原格式，无新增水印。组合、动态字段及高级效果有明确限制；预览使用系统字体和估算字形度量。
- Markdown/PDF 编辑、旧 DOC/XLS/PPT 二进制格式和完整 Office 功能不属于本轮。

## 构建与开发

首次在独立 worktree 安装根依赖后，执行 `npm run build`。各格式 package 的固定源码、独立 lock 和 sidecar 构建由 `build:office` 准备。桌面资源执行 `npm run prepare:desktop-runtime -- <Rust target triple>`，本包在既有资源流程中追加 Office：校验固定 Node 24.21.0，再分发 Office 固定资源。当前 macOS arm64 target 为 `aarch64-apple-darwin`。

界面开发使用 `npm run dev:tauri:manual`；首次启动前完成上述资源准备。静默检查为 `npm run test:office`，格式包和 native 集成另按验收记录执行。新功能保留在 `codex/office-integration`，当前工作分支的未提交内容未复制。

固定打包产物验收：先执行 `npm run build:office -- aarch64-apple-darwin` 与 `npm run stage:office-runtime -- darwin-arm64`，再执行 `node packages/office-runtime/verify-packaged.mjs`。该显式脚本在与 native 相同的 Node 权限参数、空 PATH 和临时工作目录下验证三种格式候选编辑与重开；不修改业务文件，也不等同于最终 WKWebView 窗口验收。

完整结果见 [首轮验收记录](office-first-verification-20261014.md)。
