# GenOffice 保存、版本与连续编辑调研（2026-11-01）

本包只调研，关联现有 File 编辑/版本需求 #118、Office 集成 #191；不改实现、不启动应用、不发布 Issue。依赖本项目既有 File 身份、File Version 和原生提交服务。验收范围为固定源码证据、两版 Excel 保存/恢复及 Word/PPT 差异；不做运行时或产品验收。

## 结论

- **上游 Excel 两版都仍通过保存后重新打开工作簿更新基线。** 自动保存不是按输入 debounce，而是每 30 秒及窗口失焦检查后保存；不能把升级上游当成“保存不重载”的现成修复。
- **PPT 已有可参考的内存提交机制 `commitSaved`**，本地固定源版本也已有；不必整体升级。Word 则重新解析保存字节，只在语义文档相等时避免替换编辑器内容。
- **恢复副本、编辑器 undo、不可变 File Version 是不同机制。** 本轮核查的 Excel 恢复路径按文件维护一份副本，正常保存清除，不是可浏览历史版本。未在所核查保存路径找到“空闲 15 分钟/1 小时生成历史版本”的策略；这不是对全仓或所有产品能力的不存在断言。

## 来源与复现边界

官方仓库 [genspark-ai/genoffice](https://github.com/genspark-ai/genoffice) 已经 web 工具在线核验；`git ls-remote ... HEAD` 在本次取得 `36a509e8fc16ace85ed7afa3c37acb7b9c441ad1`（下称 HEAD）。本项目 [Excel upstream](../../packages/office-xlsx/upstream.json)、[Word source-lock](../../packages/office-docx/source-lock.json)、[PPT source-lock](../../packages/office-pptx/source-lock.json) 均固定 `d32d1711f1bf985430757b8c6b3fbddd3831d946`（下称固定版）。HEAD 只代表调研时快照，不表示发布版本或本地已接入。

取证读取 Git tree 与固定 SHA 的 raw 源码；公共 git/raw 可用，`gh api` 因账户 HTTP 403 未使用成功。未执行上游测试、编译、UI 或性能基准；未验证本项目复用这些机制后的保真性和体验。

## Excel：自动保存与成功回执

两版 `App.tsx` 都配置 `setInterval(tick, 30_000)` 与 `window.blur`。tick 读取当前 journal；无改动、保存忙、单元格正在编辑、需要首次另存的导入、CSV 等跳过。恢复副本另有独立 30 秒 tick，与 AutoSave 开关分离。源码的 debounce 命中不能直接解释为文件自动保存（例如图表/单元格扫描也用 debounce）。[固定版 App](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/renderer/App.tsx#L635)、[HEAD App](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/renderer/App.tsx#L729)

`createSaveGate` 串行执行保存，手动保存排队，周期任务忙时跳过；失败不会永久占用队列。`shouldRunSaveTick` 把是否允许保存集中为可测策略。[固定版 scheduler](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/renderer/save-scheduler.ts)、[HEAD scheduler](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/renderer/save-scheduler.ts)

成功保存的 renderer 路径在两版均调用 `openLazyWorkbook`。HEAD 主进程明确说明旧 sidecar 仍读取保存前字节，因此关闭旧 session、清理资源，再 `openWorkbookSession` 读已保存文件。renderer 重装工作簿，journal 从新基线开始；`snapshotJournalCells`/`carryLateJournalCells` 将保存期间新增的单元格编辑带入新 journal，避免错误清除新改动。该保护不能未经验证扩展解释为覆盖所有结构/格式并发编辑。[固定版 save-actions](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/renderer/save-actions.ts#L482)、[HEAD save-actions](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/renderer/save-actions.ts)、[HEAD main](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/main/sheets-main.ts#L3690)

`stashViewRestore` 保存当前 sheet、活动单元格和 viewport 起点；`undo-carry` 尝试跨重装保留 Univer undo。sheet 结构操作、尚未消费的 undo stash，以及两阶段保存有明确限制，两阶段保存清除 carry。它们是重装后的恢复措施，不能证明 workbook 内核未销毁，也不保证任意多选区、正在输入文本或全部 undo 均无损。[固定版视图恢复](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/sheets/src/renderer/App.tsx#L4479)、[HEAD 保存约束](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/renderer/save-actions.ts)

## 恢复副本与历史版本

HEAD `recoveryPathFor` 将文件路径 SHA-1 截断后映射为 `userData/sheets-autosave/<hash>.xlsx`；重复写入同一路径。`writeWorkbookRecovery` 用正常 workbook 写入管线导出，但不切换当前 session，原文件保持不变；正常保存删除副本。恢复打开和另存/CSV/未命名文件另有条件。这证明“导出副本不切换当前编辑 session”可以独立于“把保存字节采纳为下一次编辑基线”，后者不能仅靠删除 reopen 调用实现。[HEAD 恢复路径](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/main/sheets-main.ts#L2186)、[HEAD recovery handler](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/main/sheets-main.ts#L3780)

核查限于两版 Excel App/save-actions/save-scheduler、HEAD main 及相关恢复代码，未全面追踪 CLI、企业目录、云同步或全部生命周期；没有据此断言 GenOffice 任何位置都不具备历史能力。

## own-write 与外部修改

HEAD 公共 `disk-watch.ts` 提供 `beginOwnWrite` 暂停通知、`endOwnWrite` 更新 mtime/size 基线后恢复、`acknowledge` 接受外部变更、`isCurrent` 检查；轮询可检测 rename 替换，重复 stamp 不重复通知。**本轮未确认各 Office 格式的接入覆盖**，不能把公共工具的存在写成 Excel 已用它抑制所有自身写入事件。固定版同路径 raw 返回 404，未继续追踪它当时的其他路径。[HEAD watcher](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/electron-utils/src/disk-watch.ts)

Excel HEAD 主保存另有 SHA-256 外部修改检查与新 session hash 基线；Word HEAD 保存前对记录的磁盘状态检查，成功 atomic write 后 `rememberDiskState` 更新 hash/mtime/size。Word 自动保存遇到外部修改保留 dirty，交给手动保存处理。这些冲突保护与 watcher 自身写入抑制不能互相替代；公共 watcher 的 mtime/size 比较也不能替代本项目原生版本 CAS。[Excel main](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/main/sheets-main.ts#L3645)、[Word main](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/docs/src/main/docs-main.ts#L5018)

## Word / PPT 的可复用差异

**Word 固定版**：先捕获编辑器文档 snapshot；保存完成后若用户继续编辑、字体设置版本或密码意图改变，保留新状态 dirty，不用旧回执覆盖。否则重新解析保存字节并构造新的 PM 文档；`doc.eq` 相等时跳过 `setContent`，保留 undo/caret/scroll，不相等才替换并重置 history。因此是“更新持久化索引/基线、尽量不改交互文档”的参考，并非完全不解析。[固定版 file-actions](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/file-actions.ts#L1058)

**PPT 两版**：主进程 `writeDeckFile` 成功后 `commitSaved(session.opened)`，将保存 patch 采纳到内存并更新 XML anchors、清 dirty；代码明确避免整包重读/解压，元素 id 保留。renderer 仍接收 render slides、调用 `adoptSavedSlides`，因此仍需核查响应采纳是否打断正在操作的 UI。固定版 renderer 的“保存重开、id更新”注释与主进程实际 commitSaved 已不完全一致，应以真实调用链为准。[固定版 slides main](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/slides/src/main/slides-main.ts#L4450)、[HEAD slides main](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/slides/src/main/slides-main.ts#L4627)、[固定版 renderer](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/slides/src/renderer/file-actions.ts#L30)

HEAD Word/PPT App 也采用 30 秒与 blur 自动保存；PPT 跳过文本/表格编辑和按住鼠标时刻，以免打断交互。[Word App](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/docs/src/renderer/App.tsx#L5823)、[PPT App](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/slides/src/renderer/App.tsx#L1000)

## 对本项目的约束

可选择性参考：串行保存门、忙碌输入的 tick 条件、保存请求 snapshot 与晚到编辑保护、成功回执后仅推进已保存基线、PPT 内存 `commitSaved`、own-write 与外部修改检测分离。以上均不需要整体升级 GenOffice。

不能照搬：Electron 的路径/窗口权限、单副本恢复作为 File Version、mtime/size 作为原生 CAS、“保留 iframe/补回选区”等同无内核重开。短周期工作副本落盘、不可变历史归档时机及其崩溃恢复应由本项目统一 File 服务定义；15 分钟与 1 小时是待决定的产品策略，并无本轮已验证的上游默认值。

## Project Mind 当前链路：源码确认与尚未复现的边界

本地基线为 `47417420cba9da0680583ac94d98f1f99d81ad4a`。本轮没有修改生产代码，也没有运行应用或测试；下面确认的是源码行为，不声称已复现用户设备上的完整闪烁过程。

| 环节 | 已确认行为 | 影响 |
| --- | --- | --- |
| [OfficeFileContent](../../src/components/office/OfficeFileContent.tsx) | 已提交的编辑停止变化后 1200ms 自动保存；组合输入/未提交单元格、忙碌或错误时暂停；保存期间 `frozen` 包含 `snapshot.saving` | 不是每个按键同步写盘，但连续几次短暂停顿就可能多次保存；保存期间整层只读 |
| [OfficeEditSession](../../src/lib/office-edit-session.ts) | 保存成功替换 model、推进 version/hash、清空 edits；保存中拒绝 `replaceEdits` | 当前会话不支持一边保存快照一边接收下一批编辑 |
| [Office 原生服务](../../src-tauri/src/file_office.rs) | `save → prepare_edit → FileContentService.update` | 内容持久化与版本提交共用一次操作，只有相同内容 hash 可走 no-change |
| [版本服务](../../src-tauri/src/db/file_versions.rs)、[目录文件保存](../../src-tauri/src/db/project_directory_files_restore.rs)、[目录版本登记](../../src-tauri/src/db/project_directory_files.rs) | 有内容变化就增加版本并保留不可变字节；目录文件写回原位置后也登记版本 | 不能靠前端少刷新版本菜单减少真实版本/磁盘占用 |
| [Excel frame](../../packages/office-xlsx/frame-browser.ts) | `savedModelUpdate` 保留 iframe，但创建新 ready 并发送 `saved` | 已有优化可复用，不能误判为每次都重建 iframe |
| [Excel renderer host](../../packages/office-xlsx/renderer-host.ts) | `acknowledgeSaved` 锁定旧 unit，保存部分 undo/选区/滚动状态，再调用 `openLazyWorkbook` | 工作簿内部仍重开；sheet 身份变化时 undo carry 受限 |
| [XlsxEditor](../../src/components/office/XlsxEditor.tsx) | `observeReady` 遇到新 ready 时显示加载 overlay | 内部重开和加载提示都有明确代码路径，但用户观察到的全部触发来源仍需真实链路复现 |
| [父级内容组件](../../src/components/document/ProjectFileContent.tsx) | 干净编辑器遇到版本查询失效会 revalidate；保存回执也推进 loaded baseline | 实施时需要区分自身写入回执与真正外部变化，不能一概屏蔽刷新 |

[MarkdownFileContent](../../src/components/document/MarkdownFileContent.tsx) 也有 1200ms 自动保存并复用 OfficeEditSession，所以人工文件版本策略不能仅在 XLSX 包里实现。Word/PPT 当前共享宿主保存层；各格式是否重新挂载、重置 undo 应沿实际接入入口验证，不能从未使用的轻量编辑器文件推断。

现有 [OfficeFileContent 测试](../../src/components/office/OfficeFileContent.test.tsx) 明确断言 1199ms 不保存、1200ms 保存；[Excel 保存/撤销浏览器测试](../../packages/office-xlsx/tests/save-undo-browser.test.mjs) 验证了 iframe 身份、部分选区和 undo，但没有断言 workbook unit 不重建、加载蒙层不出现、保存期间连续输入不中断。这些是后续回归需补的实际缺口，本轮没有重新运行这些测试。

## 推荐产品规则（提案，尚未实施）

核心是同一 File 内分开三件事：当前内容持久化、不可变 File Version 归档、编辑器交互状态。当前工作内容是原生 File 服务管理的权威内容，不是只存在 React 内存或 localStorage 的草稿，也不另建一套 File 身份或数据库。

| 用户动作/条件 | 内容保存 | 历史版本 |
| --- | --- | --- |
| 人工连续编辑 | 已提交的输入继续短周期保存，具体秒级节奏结合文件成本验证 | 不逐次增加 |
| Cmd/Ctrl+S、工具栏保存 | 立即 flush 到原生文件，失败保留待保存编辑 | 默认不强制增加 |
| 文件连续 15 分钟没有新的编辑操作 | 先确认最新内容已落盘 | 与上次归档不同才形成一个新版本 |
| 期间再次编辑 | 保存新内容并重置该文件的空闲时间 | 旧定时任务不得归档新会话 |
| 无新修改继续放置 | 无重复写入要求 | 不周期性重复生成 |
| 切换/关闭标签页、退出应用 | 确保内容落盘，未成功不能假报已保存 | 不因为每次开关立即增加版本；保留待归档状态 |
| 应用关闭或设备休眠后恢复 | 根据持久化的待归档状态继续处理 | 过期任务至多归档一次，不补造一串空版本 |

建议先用 **15 分钟**，1 小时可以作为后续同一策略参数；目前不是用户已经确定的阈值。这里建议把空闲定义为“该文件没有新的编辑操作”，包括未提交输入/组合输入期间的活动，不取整个应用或整个电脑的空闲时间；仅浏览、滚动或其他文件的编辑是否延迟归档，需要在规格中写定。

AI 写入、恢复历史及外部修改继续遵循现有独立操作语义，不自动并入人工空闲批次。它们与未归档人工内容相遇时，需要先明确保存/固定输入快照的交接，再执行 CAS；固定引用必须对应不可变字节。建议在明确的 AI 写入或恢复边界收束当前人工批次，单独标记原因。这是必要的语义提案，不能把它隐含成所有后台读取都强制新增用户历史版本。新引用针对未归档内容如何固定快照，应与 File source 读接口一并确定。

已有历史保持原字节、编号和引用；本次不回收既有历史，也不做“先生成每个小版本、只隐藏列表”的表面处理。

## 技术落地与主要难点

**保存与归档分开，但保留原生安全边界。** 当前 [FileBytesInput](../../src/lib/file-types.ts) 的 `versionNumber + expectedContentHash` 表达固定版本。新方案需要显式区分当前工作内容的 revision/hash 与归档 versionNumber；每次内容写入仍有 CAS、归属校验、幂等回执和崩溃恢复，归档只为当前已持久化内容创建不可变快照。不能反复覆盖已有 versionNumber 的字节。原生存储、DTO、source 读取/引用、外部文件变更监测与变更事件都受影响；目录原位文件和旧 managed-copy 数据均要有迁移/兼容行为。

**空闲归档由原生持久状态支撑。** React 可上报编辑活动，但 pending 归档、最后编辑时间、已保存 revision 和归档状态不能仅靠组件 timer。关闭 Tab 后、进程退出后仍须知道剩余工作；醒来/启动时核对截止时间并幂等处理。归档与新保存/外部修改竞争时以最新 revision 和会话标识判定，不能归错内容。自身保存事件只更新对应回执/元数据，真实外部变更仍进入冲突处理。

**Excel 无打断保存是首要技术验证，不是删除一个 reopen 调用。** 当前 host 的 `writeWorkbookRecovery` 只是 `capture(request)` 取得 journal，尚未落盘；`flush` 已借上游 recovery 模式提取候选输入而不重开。这是可复用接缝。建议先验证“编辑会话保持固定源快照与累计 journal，后台从该基线生成候选文件，持久化 CAS 独立指向最新工作内容”的路线。成功回执只标记某个编辑序号已保存，不替换交互 model、不清除后续操作，也不销毁 workbook unit。

这条路线会改变当前“编辑基线必须等于最新 File Version”的调用约束，须绑定同一真实 File/会话并保持原生授权；不能直接绕过 `latest()`。公式/样式/新增 sheet 的标识、结构 journal、撤销后再次保存，以及长时间会话的内存/序列化成本是验证重点。如果必须原位推进编辑基线，则需要完成各类 journal/索引映射，不能仅把 hash 换新。PPT 的 `commitSaved` 和 Word 的语义相等检查提供格式内参考，但不直接作为 XLSX 可用接口。

**允许保存期间继续操作。** 请求捕获编辑序号 N，回执只确认 N；N 之后的修改继续 dirty，并串行保存下一批。保存状态与只读权限分开；自动保存不强制结束当前 IME/单元格输入，不抢焦点。临时导出与真实文件落盘失败都必须可见，不能借用上游 best-effort recovery 的吞错行为作为“已保存”。

这些变更与 [ADR-0003](../adr/0003-persist-only-committed-editor-content.md) 的“只持久化已提交内容”、[ADR-0009](../adr/0009-bind-agent-operations-to-workspace-and-atomic-receipts.md) 的原子回执边界一致，前提是保留上述约束。现有 [#118 需求](../requirements/project-file-integration.md) 写明“保存并产生新版本”，需要在实施规格中明确被本次已确认需求修订为“保存内容与归档版本分开”；不能让旧验收条件与新实现矛盾。

## 建议工作包与验收

下面是实施拆分，不代表已认领或已完成。历史背景是 #118/#191，本次需求应在实施时有独立 Issue；本轮 `gh issue list` 返回 HTTP 403，未读取或更新远端 Issue 状态。

| 工作包 | 依赖、交付和文件范围 | 验收/验证范围 |
| --- | --- | --- |
| A：Excel 连续保存可行性与回归 | 先冻结无重开合同；范围为 XLSX host/frame、OfficeEditSession 和相应测试，优先复用已有 recovery/capture | 真实保存连续两次及保存中继续编辑；iframe 和 workbook unit 身份均保持；无加载蒙层；焦点、选区、滚动、undo、公式和结构修改正确；保存结果可独立重开核验。先做定向无窗口复现，不把现有 iframe 测试通过当作完成 |
| B：File 当前内容与历史解耦 | 依赖明确的 DTO/引用边界；范围为原生 File 保存、schema/迁移、source 读/引用和跨端 DTO；复用原文件身份与原生事务 | 多次内容保存只有工作 revision 变化；归档一次才增加版本；历史字节不变；同内容/no-op 不增版本；崩溃恢复、请求重放、旧 CAS、外部替换和两种存储模式验证 |
| C：人工空闲归档 | 依赖 B；范围为原生归档状态与调度、前端活动/保存状态、生命周期接入 | 假时钟覆盖阈值前后、再次编辑、无改动、关闭重开、休眠/重启、归档竞争；短周期落盘继续生效，不实际等待 15 分钟；UI 清楚区分内容已保存与历史归档 |
| D：跨格式接入与产品验收 | 依赖 A～C；范围为 Excel/Word/PPT/Markdown 保存回执及父级 File 事件 | 覆盖 Project 与 Workspace；保存过程中输入/中文/撤销不受打断；失败和冲突不丢内容；固定历史/恢复与 AI 操作交接；最后集中验收真实 macOS 编辑体验，并按交付平台补 Windows |

非目标：整体升级 GenOffice、替换 Office 引擎、通用插件平台、清理用户现有历史，以及扩张为所有 Record 的版本重构。范围判断为**中等偏大的跨前后端改动**，主要成本在连续保存与 File revision 契约，不在 15 分钟计时器。A 是优先验证的技术风险；可以与 B 的规格细化分别推进，A 未通过不能宣布整个需求可交付。

实施前按仓库要求检查 `tauri dev` 自动重启进程；开发阶段运行受影响定向用例，收口再执行工作包完整验证，并复用仍有效结果。UI 验收集中进行且提前告知。Standards/Spec 由主 agent 自查，未获用户明确同意不启动 review 子 agent；本轮仅做调研文档的来源、链接和规则一致性检查，不运行构建/全量测试。
