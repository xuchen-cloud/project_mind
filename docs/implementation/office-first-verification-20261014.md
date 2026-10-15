# Office 首轮验收记录 · 2026-10-14

关联 #118 F04/F05/F06。基线 `72e25ca420bbc4635f99bf5069c2a9c2d3183844`；分支 `codex/office-integration`。设计先使用 frontend-design 技能产出 [三格式参考](../design/office-editor-direction-20261013.html)，再对齐实际格式编辑器。实现由 DOCX/XLSX/PPTX/native/DSH transport implementation agents 并行完成；Standards / Spec 由主 agent 自检，未启动 review agent。

## 产品与保存路径

- 主项目 File 内容区识别 DOCX/XLSX/PPTX，使用实际 SDK 编辑器，宿主统一显示版本和保存状态。
- 保存按钮、Cmd/Ctrl+S、关闭文件标签、离开项目、切换版本和外部打开共用 flush。Excel 保存前提交仍在输入中的单元格；pending 内容也进入 dirty 与版本重验保护。
- native 从固定 File/version/hash 读取原件；候选结果经既有 FileContentService、CAS、历史保存及目录替换恢复提交。两次保存 rebase 到真实新版本；错误保留修改；历史只读。
- DSH rc.2 实际注册并调用 Office 工具，以真实 Session 经 native source bridge 使用同一保存服务。用户确认当前不用 Pi，已停止该方向；本包只接入 GUI 与 DSH。

## 有效验证

| 范围 / 命令 | 结果 |
| --- | --- |
| `npm run test:office` | worker 边界 4 通过；主页面/关闭 guard/save controller 6 文件 104 通过 |
| `npx tsc --noEmit`；`npx vite build` | 通过；Office 编辑器按格式延迟加载 |
| `npm run build:office -- aarch64-apple-darwin` | 三格式固定源码校验、独立锁、声明、native sidecar、许可证与分发 inventory 通过 |
| `npm run stage:office-runtime -- darwin-arm64` | 固定 Node 24.21.0 校验、目标与逐文件 SHA256 校验通过 |
| `node packages/office-runtime/verify-packaged.mjs` | 实际打包权限 worker：DOCX/XLSX/PPTX 编辑后的字节重开均通过 |
| `npm --prefix packages/office-docx test` | 14 通过；真实中文段落/表格、两轮编辑、未改 ZIP 部件、链接源数据及惰性链接渲染 |
| XLSX `node --test tests/engine.test.mjs` | 最后 candidate promotion 修复后 11 通过；跨表公式缓存、空白格、保留源部件、严格协议、独立 dist |
| XLSX native `recalc::` / 独立 OOXML 核验 | 18 通过；simple 80/80、complex 94/94 核验通过；相关代码未变化，沿用有效结果 |
| PPTX `npm test` / `npm run test:ui` | engine 7、UI 5 通过；中文文本、图片移动、两轮保存、未改部件及宽窄视图 |
| DSH unit / check | 30 通过；check 通过 |
| DSH actual rc.2 transport integration | Office discovery 4、policy/abort/replay 12 通过；原件写入另由下列 native 测试验证 |
| agent-host Office boundary | 4 通过；旧 Pi 方向不作为本包交付或门槛 |
| `check:ui-standards` 与 motion 规则测试 | 通过；20 用例通过，仅对 PPT 窄屏属性区的实际 accordion 过渡使用精确例外 |
| desktop-runtime 命令分发测试 | 3 通过 |
| bundle-boundaries | 通过；主入口 234 KiB / 250 KiB |

三格式真实 native 集成命令：

```sh
src-tauri/target-office/debug/deps/project_mind_alpha_lib-34ccca602a0d4f8c \
  --exact file_office::tests::office_real_formats_native_save_reopen_and_retained_history \
  --ignored --nocapture
```

结果 **1 通过、0 失败**。逐格式执行真实 File 版本保存、重开、保留原历史、多次保存、稳定回执重放和旧基线拒绝。最初 XLSX 的 Node 权限模式禁止 fsync；已将私有候选文件提升改为 rename，正式 File 的 Rust 持久化边界不变。修复后 engine 全套和三格式 native 测试通过；正式分发重新构建、再次执行 packaged worker 验收通过。

## Native 受影响回归

使用同一默认 test/debug profile、Rust 1.94.1、macOS arm64 编译产物；最终日志位于忽略目录 `src-tauri/target-office/`。以下范围有重叠，不累计总数：

| Filter | 通过 / ignored |
| --- | --- |
| `file_version_service::tests::`（串行） | 49 / 3 |
| `db::file_versions::tests::`（串行） | 21 / 1 |
| `db::project_directory_files::tests::` | 27 / 1 |
| `db::agent_connections::tests::` | 14 / 0 |
| `agent::bridge::file_write_tests::` | 7 / 0 |
| `agent::bridge::read_tests::` | 6 / 2 |
| `agent::bridge::write_tests::` | 8 / 1 |
| `agent::bridge::transport_tests::` | 3 / 0 |
| `agent::bridge::registry::tests::` | 11 / 0 |
| `agent::file_dispatch_tests::` | 5 / 0（原 6 项通过后删除 Pi 专属项，复用其余结果） |
| `agent::source_trace::tests::` | 3 / 0 |
| `source_bridge_` | 3 / 0 |
| Office 专项（撤去 Pi 接缝后的最终结果） | 12 / 4；真实三格式显式执行 1 通过；launcher 与目录 staged 恢复结果沿用此前有效验证 |

FileVersionService 首次失败来自旧 fixture 的非 canonical macOS 临时路径。改用 canonical 测试临时目录后同一二进制通过。一次并行 crash 子进程用例未按预期被 SIGKILL，单项重跑及完整串行 49 项通过；日志不足以断言偶发根因。串行验收仍执行各测试内部并发/CAS，不将调度限制宣称为根因修复。

用户纠正当前不用 Pi 后，已删除本包新增的旧 agent descriptor、注册/dispatch、trace 与专属测试；不保留只为 Pi 使用的 stage_edit 接口。候选测试直接覆盖真实保存路径的 prepare_edit，三格式测试直接使用 service.inspect 的模型目标。重新编译后，Office 范围 12 通过、4 ignored，真实三格式显式执行 1 通过；最终日志为 `office-gui-dsh-only-native.log` / `office-gui-dsh-only-real-formats.log`。DSH/GUI/worker 行为没有改动，前端和包验证继续复用。

## 检查范围与实际限制

Chromium / WebKit 对真实 SDK 的键盘输入、宽窄布局、只读、撤销重做、基线更换和 pending cell 进行无头验收。DOCX 两种链接渲染路径的恶意 href 均不再可执行，同时源模型和 OOXML 保留。PPT 属性区保留 DOM、连续收展、reduced-motion；参考和实际截图见各格式 README / evidence。

用户要求查看窗口后，已编译并启动实际 Tauri WKWebView 验收应用（`OfficeAcceptance.app`）。使用独立 app data、演示工作区及 dev 端口 1431，已确认 Workspace 与项目页面可见；用户正在手动验收，不将该状态提前记录为完整 GUI 保存验收通过。Office 示例位于忽略目录 `src-tauri/target-office/acceptance-samples/`；窗口与服务器保留供用户操作。

未验证 Windows 打包或复杂 Office 全功能保真。DOCX 不支持结构增删和完整分页；XLSX 首屏 A1–Z100、数值公式与明确预算；PPTX 高级效果和字体度量有限。PPTX 不新增水印。Markdown/PDF 暂缓。

全仓 `check:portable-paths` 仍报告未改研究/交接文档中的机器绝对路径；本包文档按同一规则检查无违规，不修改其他工作包。该既有失败不记录成全仓检查通过。

## Standards / Spec 自检

Standards 检查格式包边界、实际构建资源闭包、类型隔离、File 身份及权限、异步保存、版本重验、临时文件、原件保留与 UI 规范。修复了 Excel 未按 Enter 的输入未进入保存、异步重验覆盖 pending 草稿、workspace generation 捕获、Office 被通用预览大小限制挡住、私有候选 fsync 不兼容、DOCX 可执行链接及 PPT 窄屏收展检查。正式 File 持久化/恢复仍使用既有边界，没有为通过测试放宽权限或 CAS。

Spec 对照用户当前范围：主项目直接承载三格式编辑器；DSH 复用原格式能力与真实 File 保存；简单编辑/保存/重开、无新增 PPT 水印；独立 worktree；先 frontend-design 设计参考并遵循当前主题；Markdown/PDF 暂缓。用户纠正不使用 Pi 后，撤回该方向的新增接缝，既有 legacy 子系统不扩展为本包职责。

该实现范围没有剩余 code review 发现。窗口已交给用户手工验收，尚未把父 Issue 或完整 Office 功能记录成完成。

本包只完成 #118 的 Office 首轮，保留父 Issue。当前分支从已有 AI/UI 提交基线创建，直接面向 main 合并会夹带其他工作；本次仅在独立 worktree 提交 Office 变更，不执行该合并。
