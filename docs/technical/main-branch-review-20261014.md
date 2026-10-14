# Main 分支差异检视

日期：2026-10-14。工作分支：`codex/ai-enhancement`。状态：主 agent 按特性完成本轮检视与清理；子 agent 执行未返回结论。

## 工作包范围

关联 #121（AI）、#124（Project 内容）、#125（会话模型），并核对 #94 Voice 和 #56 驻留文档。比较固定为 `main f8723d81e05b16a1863c541d592320600b528173...e136933bce4f938397aa374b69851cd480808272`，共 214 个提交；本轮工作区修复另行检查。

依赖：已有 Tauri/React 原生调用、固定版本 Record/Source worker、已锁定 Pi/DSH runtime。交付：删除生产无引用模块，修复检视中确认的问题，让当前基线与真实能力一致。非目标：补齐全部 AI 产品规格、引入 Office 编辑、替代真实 Provider/Windows 验收或发布整条分支。验收：删除项无生产引用，受影响构建/测试通过，文档链接有效且保留真实交付缺口，Standards 与 Spec 分开记录。

## 特性分工

| 特性 | 重点 |
| --- | --- |
| DSH 会话与模型 | 凭据、传输、Project/Session 运行归属、composer 模型选择 |
| File 与固定来源 | 稳定 ID、位置核验、不可变版本、恢复、来源证明 |
| Project 内容与 Record | 对象去重、双栏、驻留、关闭保存、canonical CAS |
| 原生 AI | Pi/CLI/MCP 授权、工具 schema、成果与维护生命周期 |
| Voice | 会话终态、双轨、有限重连、缺口恢复 |
| 整体与重叠 | 清理引用、跨模块契约、文档与实际产品入口 |

已按特性委派独立子 agent，并另设整体 reviewer；执行多次停滞未返回结论，已停止。以下结果由主 agent 按特性核对实际调用链、修复及统一验证得出，不记为子 agent review 通过。第三方固定上游以接入边界、许可/完整性测试核对，不声称逐行审完所有 vendored 文件。GitHub Issues/远端读取失败，比较固定到上述本地 main，不声明远端已同步。

## 已修复的发现

### Standards

- 46 个前端源文件、测试、样式与资产形成旧 UI 的孤立引用岛：旧 Pi 来源/成果/知识/记忆界面、旧文件预览、退休设置和辅助函数。按 `main.tsx`、`voice-main.tsx`、worker 入口的静态/动态 import 与资源 URL 图，加仓库引用搜索确认后移除。实际原生 Pi、CLI/MCP 和仍在消费的旧预览请求转换保留。
- 恒返回 false 的历史 DSH 导航拦截函数与分支移除，真实 Project 路由验证后台任务归属保留；Workspace 关闭的 busy 保护仍由实际生命周期处理。
- 四个无调用 Rust 包装函数移除：`agent_output_scope`、`SourceService::registry_entry`、`CapturedPublishedItem::capture`、单消息 `overview_session::segment`。保留实际 DB/service 方法和批处理实现。
- 旧独立 DSH 交接、被实施结果替代的 Desktop 调研交接和旧 Pi GUI HTML 指南移除。唯一未完成的临时放大阅读栏及平台限制迁入[未完成事项](../remaining-work.md)。历史 UI 测试证据改为移除前提交链接。
- 基线修正 schema v37、DSH/Pi 接入边界、内容路由、固定版本预览、Overview 五实例与独立内容页驻留。原生 Voice 的过期 TODO 删除；事件协议仍如实记为快照轮询。

### Spec

- **P1 工具初始化失败：** 原生 `output.stage` 的 canonical schema 重复嵌套容器使实际 manifest 超过 Host 的 512 节点预算。将容器放入共享 `$defs`，保留数组数量、深度及原预算；真实原生 manifest 通过 Node 校验。
- **P2 异步关闭覆盖新导航：** 当前 Project 7 关闭等待保存期间切到 Project 8，外层关闭旧回调跳回 Workspace，内层内容关闭旧回调跳回 Project 7。两条真实路由/延迟保存用例先复现失败；外层关闭和分离窗口回调完成后读取最新选中项，内层关闭完成后核当前项目是否仍可见，再判断是否跳转。保存失败与工作区 generation 保护保留。
- **P2 验证夹具失配：** macOS 临时根路径的符号链接路径与 canonical 路径不同导致 13 个 File 用例误触归属拒绝。三组夹具先 canonicalize；生产路径/权限规则保留。
- **P2 前端与 runtime 验证过期：** Workspace launcher 和 DSH busy 文案断言更新到现行入口；五个 `node:test` 文件移回 Node runner。App 只在实际面板/内容栏查询，并与专门 DSH renderer suite 分工，避免全局 CSS 引起的顺序耗时；原有断言及超时保留。DSH 恢复复用已有严格历史前缀断言，仅允许关闭时追加 `session/end-seed`。
- **P2 设置范围文案：** 设置页曾声称配置作用于所有项目和会话，但原生策略未完整控制 DSH。说明改为工作区知识维护/命令行助手，并指向会话内的项目聊天权限入口；完整共享行为接线继续按 #121 验收。

## 验证记录

对应范围：固定初始 HEAD 加本轮清理/schema 修复。没有相关后续源码、依赖或配置变更的已通过结果复用；失败项修复后只重跑对应范围。

| 命令/范围 | 结果 |
| --- | --- |
| `npm run build` | TypeScript 与生产构建通过 |
| `npm run test:unit -- --maxWorkers=1` 加修复后的受影响文件 | 184 文件、1519 用例的组合证据：180 文件 1463 项复用；App 36、内容工作区 11、host events 6、settings 3 项最终通过 |
| 五个独立 Node artifact/runtime 文件 | 21/21 通过 |
| `cargo test --lib agent` 加 schema 断言定向复测 | 412 通过，12 ignored；ignored 不计通过 |
| `cargo test --lib source_service` | 16 通过，4 ignored |
| `cargo test --lib overview_maintenance::tests::session_tests` | 4/4 通过 |
| Agent Host check / unit / Pi | check 通过，16 + 49 用例通过 |
| DSH check / unit / integration 加历史恢复定向复测 | check 通过，29 unit 与 10 integration 用例通过的组合证据 |
| `cargo test --lib dsh_assistant` | 18 通过，1 ignored；核原生 DSH 归属、凭据与生命周期 |
| UI standards / portable paths / bundle boundaries | 均通过；保留文件预览/Office 调研证据，路径按环境变量表示 |
| 修改文档的本地链接、`git diff --check` | 通过 |

应用构建与单元验证没有打开桌面窗口。日志为本机临时验证产物，结果与复用边界记录在本表；不作为真实模型、设备或平台验收。

## 尚未交付的产品能力

Workspace 聊天入口、DSH 与完整知识/记忆/原生成果工具的接线、统一 Skill/Harness 仍有差距。Office 编辑、HTML 交互执行、临时阅读栏放大仍有各自的需求与验收。Voice 的真实服务/设备恢复、Windows 安装与 WebView2、多项目长历史内存证据继续留在[统一待办](../remaining-work.md)。这些限制不因清理或自动化通过而关闭对应 Issue。

## 特性核对结果

| 特性 | 主 agent 核对的边界与结论 |
| --- | --- |
| DSH | `dsh_assistant.rs` 的 Project 配置、Workspace generation、启动后的身份复核、锁/切换时停止；`transport.mjs` 的 Project/connection ID 与释放；`model-picker.jsx` 的 Session 选择及异步 lifetime。确认设置范围文案问题并修正；完整共享策略仍待接入。 |
| File | `file_version_service.rs` 的固定历史 hash、commit fence、幂等恢复；`db/project_directory_files.rs` 的物理身份、显式位置确认及 CAS。此范围未确认新增产品 bug；修复了测试根目录失配，保留所有生产校验。 |
| 内容与 Record | 内容布局的稳定对象去重、左右栏移动、保存后 generation 检查；`useCanonicalRecordEditor` 的权威正文及草稿基线；App 的整体关闭/分离与内层内容关闭。确认并修复两个异步导航竞态，更新驻留文档。 |
| 原生 AI | `output_commands.rs` 按实际 Run 收据建立权限；`output_service.rs` 按对象处理批量撤销、编辑锁及幂等；native manifest 与 Host schema budget。修复预算超限，未删除权限、CAS 或 receipt 保护。 |
| Voice | FSMN 实际接入、`live_paraformer.rs` 的有界重连、`recovery.rs` 的保存音频回填与提交前 Workspace 身份复核、DB cursor CAS；后台 tick 继续驱动分片恢复。此范围未确认新增产品 bug；移除过期 TODO 并保留设备/服务验收。 |
| 整体 | 删除引用图、构建资源、测试 runner 分工、旧历史证据与当前 GUI 接入范围、缓存基线。已修复发现见 Standards / Spec；真实产品缺口统一保留在待办。 |

本轮列出的确定发现已处理。此检视和自动化结果不能替代全部 Issue 的产品验收，也不作为整条分支发布或关闭 Issue 的证据。
