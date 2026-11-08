# 人工 File 连续保存与空闲归档

用户已授权实施；历史关联 #118/#191，本次 GitHub Issue 创建/查询被账户 HTTP 403 阻断，不能伪称已建立 Issue 或完成发布。

基线：develop `7e9b5b6`，独立分支 `codex/file-save-sessions`。原语音提交 `4741742` 保留在原分支。开始源码修改前检查无 tauri dev 自动重启进程。

交付：人工文件内容及时落盘；保存期间允许继续编辑且不重开编辑器；15分钟无编辑后生成一次不可变历史；关闭、重启和休眠不丢 pending；保留原生归属、CAS、回执、固定历史与AI/外部变更边界。非目标：整体升级上游、删除历史、Record版本重构。

依赖与分工：Rust agent负责原生工作内容/归档/迁移/调度；XLSX agent负责固定基线累计journal、不重开与真实格式回归；Word/PPT agent负责格式回执和晚到输入；主agent负责File UI、Markdown、会话协调和最终整合。文件范围不重叠，review由主agent执行。

验收与验证：先真实编辑器保存快照回执红绿，再原生工作内容和不可变历史接口红绿，再假时钟/生命周期/冲突；定向用例通过后集中完整受影响验证。真实UI验收提前通知；不启动review子agent。调研及详细约束见[调研记录](../technical/genoffice-save-version-research-20261101.md)。

## 交付结果

- Office / Markdown 的当前内容与历史版本分离。人工编辑自动保存当前文件，默认 15 分钟无编辑后生成一次不可变历史。手动保存和关闭不会强制产生版本；重启后继续处理持久化的归档期限。
- 保存保持固定编辑模型和累计修改，回执只确认已保存的编辑序号；保存期间可继续输入，后来的修改继续保持未保存状态。Excel 不再重新打开工作簿，Word/PPT 不替换交互内核，撤销记录与输入焦点保留。
- 旧历史字节保持不可变；精确失败重试复用请求身份；外部修改由 CAS 拒绝，单份最新成功保存内容仍可恢复。显式 AI 当前文件读取可提前建立固定证据版本，后台列表和索引不会触发此归档。

实现细节见[原生持久化](file-working-content-notes.md)、[Word/PPT 与父级](office-continuous-formats.md)、[Excel](xlsx-continuous-save.md)。

## 完成验证

验证对应本工作包最终源码；不重复运行仍有效的检查。未启动 Tauri 应用窗口。

| 范围 | 命令或测试入口 | 结果 |
| --- | --- | --- |
| 原生编译 | `cargo check --lib` | 通过 |
| 原生受影响回归 | contacts / file_versions / project_directory_files / source_files / file_version_service / file_office / file_text / editor_remote_image | 210 passed，10 个既有 opt-in/child 用例 ignored |
| 工作内容、迁移及恢复 | file_working 测试组 | 11 passed，1 child-only ignored；父测试实际执行四阶段 SIGKILL |
| 真实原生 Office 连续保存 | `office_real_formats_working_saves_share_fixed_base_and_archive_once --ignored` | DOCX/XLSX/PPTX 全通过；最终 7.13 秒 |
| 前端类型与打包 | `npx tsc --noEmit --pretty false`；`npx vite build` | 通过 |
| 三格式分发资源 | 各格式 build、office-distribution、stage-office-runtime | 通过 |
| 资源及 worker 回归 | office-distribution / office-renderer-resources / office-worker | 29 passed |
| 父级及 Markdown | 六个 document 测试文件 | 127 passed；末次元数据修正另跑 3 项通过 |
| Office 宿主 | OfficeFileContent | 43 passed；历史 fixture 调整后受影响 5 项通过 |
| 会话与归档错误提示 | file-edit-session / useFileWorkingErrors | 5 passed |
| 工作区、预览、桥接及选区 | ProjectContentWorkspace / ProjectContentLayoutView / OfficeFileSelection / OfficePreviewView / officeFileApi / officeSelectionApi | 71 项原有检查通过；迁移选区旧保存假设后该文件 12/12 通过 |
| App 集成 | App.test.tsx | 56 passed |
| 格式局部 | DOCX scheduler / PPT UI / 真实 vendor save receipt | 10 / 25 / 1 passed |
| 真实浏览器与引擎 | 三格式连续保存；Chromium + WebKit | 通过；Excel 10 次实际保存/重开校验，Word/PPT 各 3 次，覆盖晚到输入、焦点、撤销 |
| UI 与 diff | check-ui-standards；git diff --check | 通过 |

全仓 `check-portable-paths` 因未修改的历史文档和 vendor 示例已有绝对路径而失败；本包变更文档单独检查无违规。未执行原生 macOS GUI 或 Windows 端验收，不将浏览器和原生 worker 验证描述为上述验收。

## 主 agent 自检与发布状态

Standards：已检查真实调用路径、GUI/Agent 权限边界、Project/File 锁顺序、跨异步后的校验、FULL 持久化、回执幂等与资源上限；保持现有领域身份与固定历史语义。Spec：已检查连续编辑不重载、不因保存锁编辑器、旧回执不清掉新输入、空闲归档/关闭/重启、历史切换与真实外部冲突。自检发现的回执重放顺序、Office admission 失败释放、own-write 先于回执、历史与当前内容混用、权限更新打断输入等问题已修复并完成对应验证；无剩余阻塞发现。未启动 review 子 agent。

GitHub API 返回 `HTTP 403: Sorry. Your account was suspended`，本次无法建立 Issue、创建 PR 或执行远程合并。保留独立实现分支与本地提交；账户恢复后按最小发布流程补 Issue、推送、PR、合并及关闭 Issue。用户原有未跟踪文档 `docs/technical/windows-release-handover-20261026.md` 不属于本包，不纳入提交。
