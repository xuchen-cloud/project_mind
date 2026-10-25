# Office 创建、CLI 与 Skill 契约调研

日期：2026-10-25（Asia/Shanghai）。范围：核查实际使用反馈，判断优化必要性，并调查是否能复用 GenOffice 原有 AI 创建能力。本次只新增调研文档，不修改实现、不创建 Issue、不发布。

## 结论

反馈的核心判断成立，值得优先优化。问题横跨生成能力、原生 File 创建、Skill 资源读取、内容抽取和验收契约，不能只放宽 CLI 扩展名白名单。

建议复用 GenOffice 的文档生成和格式处理能力，由 Project Mind 的现有助手编排，并统一通过原生 File 创建/更新服务提交。二进制导入仍需补齐，作为 GenOffice、其他生成器及已有文件共同使用的持久化入口。

最先交付三个闭环：

1. 修复 Skill references 的实际读取路由，并准确暴露不支持抽取的原因。
2. 接通 GenOffice DOCX 创建到原生 File 提交；同时提供正式二进制创建/导入入口。
3. 补充 Skill 的 Office 生成、作用域路径、目录发现、版本、回执及校验说明，并验证全新助手能走通。

## 调研基线与证据范围

- 当前 worktree：`2b7e67055fcefc5aaef1cacaf2952ea3796229cf`，与本地 `origin/main` 一致，只有较早的 Agent foundation，不能据此判断用户遇到的现行 CLI 行为。
- 已获取最新 `origin/develop`：`3b1c19ed1ecb6e49d481f7050235f419f56d7c53`。下文产品代码、文档和测试结论均针对该提交，通过 `git show` 读取，未切换当前工作区。
- GenOffice 按本项目锁定版本核查：`genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`，没有用上游最新版本代替安装版本判断。
- 未获得用户当次 DOCX、命令完整日志或安装包 commit，因此不声称已复现用户安装环境，也不确认其 pandoc 架构或 Python 依赖状态。

## 反馈逐项核查

| 反馈 | 判断与证据 | 建议 |
| --- | --- | --- |
| CLI 无二进制创建 | 成立。`AgentFileCreateInput` 只有 `utf8Content`，白名单限 md/txt/html/htm；上传 target 则强制已有 ObjectRef、版本和 hash。[创建校验](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/db/file_imports.rs#L30)、[上传目标](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/agent/bridge/cli_upload.rs#L24) | 属于正式能力缺口。扩展 native DTO、授权、暂存和原子提交，不能仅放开扩展名。 |
| Skill references 读不了 | 成立，存在明确代码链路：所有 `read` 都进入 native `prepare`；其只认可当前授权的托管 File 路径或固定 token。包外/项目外的 Skill 文档因此落入 scope 拒绝。[中间件](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/dsh-assistant/scripts/source-bridge.mjs#L148)、[归属校验](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/dsh_assistant.rs#L749) | 为实际已发现、启用且授权可读的 Skill 资源提供独立读取路由。核验 canonical 路径和符号链接，不能放开任意项目外路径，也不能伪装成业务 File。必要内容内联可临时缓解，但不是根治。 |
| DOCX detail 长期 SOURCE_NOT_READY | 成立，但原因是确定性“不支持”，不是等待索引。通用抽取仅支持 txt/md/markdown/html/htm/pdf；list 捕获错误后丢弃具体消息，只返回错误枚举。[格式选择](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/db/source_files.rs#L206)、[list 降级](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/agent/file_list.rs#L137) | 首先返回明确原因和是否可重试；之后复用 Office 模型形成有格式定位的文本投影，统一 detail、source.read、contentQuery/索引的支持范围。只增加刷新按钮无效。 |
| list 简写和错误信息误导 | 成立。通用 JSON 分支在检查 input 是否存在前调用 `reject_scope_options`，所以没有 `--input-file` 也能报参数冲突；`--limit` 当前只准用于 reference.list。[校验函数](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/agent/bridge/cli.rs#L238)、[limit 限制](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/agent/bridge/cli.rs#L644)、[通用分支](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/agent/bridge/cli.rs#L782) | 先准确报“此命令需 --input-file PATH 或 --input-file -”，再统一 file/record/todo list 的 scope、limit、cursor 简写，避免只补一个命令。JSON 不局限 stdin，也支持 JSON 文件。 |
| capabilities/doctor binding 规则 | 部分成立。capabilities/schema 离线且拒绝 binding；doctor 在线，必须带 workspace/connection。顶层帮助和主 Skill 示例其实已区分，注入 prompt 的泛化 Binding flags 容易误导。[真实命令规则](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/agent/bridge/cli.rs#L608)、[帮助](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/agent/bridge/cli_help.rs#L6)、[注入 prompt](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/dsh-assistant/scripts/mind-cli.mjs#L29) | 明确离线发现和在线连接诊断的差异。优先修 prompt/错误说明，不建议默默忽略 binding，避免让调用方误以为拿到当前连接的授权能力。 |
| 无二进制 CLI 回读 | 成立。raw source 只支持四类文本；versions 接口只给元信息。但底层已有固定版本、hash 和授权检查的字节读取。[raw source](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/file_source_read.rs#L86)、[安全字节读取](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/db/project_directory_files.rs#L1733) | 可增 file download/export --out，或明确的 binary mode；本地解码、原子写出，stdout 返回版本/hash/byteLength，避免大块 base64 进入模型上下文。 |
| Office 路径规则不清 | 成立。相对路径拼接到实际 Session directory；Project 会话已在项目根，重复加项目名前缀自然找不到。Workspace 会话才需要项目目录前缀；Workspace 自身 File 用 files/。[工具说明](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/dsh-assistant/scripts/office-service.mjs#L52)、[路径实现](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/dsh_assistant.rs#L768) | 分会话说明裸文件名、项目内相对路径、工作区相对路径和绝对路径。工具优先接完整 ObjectRef/SourceRef；数字 ID 简写必须结合 binding scope。不要要求助手自己编造固定 token。 |
| 目录投放是暗规则 | 文档缺口成立，但实现是后台轮询 discovery，不是文件系统 watcher。每 5 秒、每页 5 文件；扫描未归档 Project 和 Workspace files/，排除隐藏/临时/symlink/特殊文件；并无普通业务扩展名白名单。[后台服务](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/project_file_maintenance.rs#L16)、[扫描范围](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/db/project_directory_files.rs#L1362)、[排除规则](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/db/project_directory_files.rs#L1572) | 写清触发、排除、100 MiB 快照限制与失败状态，不承诺固定导入延迟。Workspace 根目录的任意文件不会自动成为 Workspace File。 |
| 无删除和外部版本提示 | CLI 未暴露 file.delete 成立，产品 native 已有删除 journal/tombstone。版本/hash CAS 已保护写入，缺提示主要增加恢复成本，并非已证实可静默覆盖。[删除实现](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/db/file_deletions.rs#L1)、[File CAS](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/agent/bridge/cli.rs#L337) | 删除作为单独权限/产品决策。先改善冲突错误附带的当前版本信息、重读引导；是否增加主动事件订阅另行评估。 |

### 目录发现不能替代正式创建

初次目录登记调用 publish 时没有 CLI creation receipt，只有带 receipt 参数的提交路径才写 OperationReceipt。因此不能保证目录投放后存在可按原请求恢复/undo 的创建操作。用户“误导入只能撤销”的判断也需要限定：发现导入未必存在相应的 CLI 撤销回执。[登记路径](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/db/project_directory_files.rs#L433)、[收据分支](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/src-tauri/src/db/project_directory_files.rs#L678)

`.11.pm-versions` 是历史目录的内部布局，应说明其含义并禁止助手直接维护；标准验收应依赖 File ID、版本/hash、原生收据和授权读回。已有文件内容变化并非由 discovery 持续自动升版；显式 resolve/read 会检查内容并处理外部版本。不要把“发现新路径”和“发现已有内容变化”混为一谈。

### 抽取状态与校验要准确

不建议写入“DOCX SOURCE_NOT_READY 是正常现象，一律不要重试”。应写成“当前通用文本抽取不支持 Office；此原因不会因等待或升版解决，改走 Office inspect，并说明内容搜索覆盖不完整”。同一错误枚举还可能承载其他来源故障，必须根据具体原因分流。

现有校验可以分两层：

- 字节：本地待提交产物 SHA-256 与固定 File Version 的 contentHash 对比，连同实际版本和对象确认。
- 内容：Office inspect 的 SourceRef 版本/hash 与目标一致，再检查正文/表格等语义内容。编辑器保存成 v2 后，应核验 v2 自身内容及新 hash，不能要求它等于最初 v1 的字节。

hash 只能证明字节一致；不能证明排版、公式语义或用户所需内容正确。复杂文档仍需实际打开/渲染验收。

## 能否复用 GenOffice 原有 AI 能力

可以，且建议作为 Office 创建的主方向。但要区分“上游有能力”“本项目已接入”和“无需适配即可调用”。

| 格式 | 锁定上游已有能力 | 接入限制与建议 |
| --- | --- | --- |
| DOCX | `create_document` 接 restricted HTML，创建独立 DOCX；`write_document` 按提纲/context 流式写入空白或现有文档；还有 insert_content、apply_ops 等内容/结构/格式操作。[工具定义](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/ai/tools.ts#L131)、[create_document](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/ai/tools.ts#L619) | create_document 的初始内容不支持图片/图表；write_document 依赖 editor 与 panel-owned writer。原创建流程打开空白 Docs tab、消费队列内容后自保存，不能直接视为已取得最终 DOCX 字节和原生 File 收据。[上游创建流程](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/main/docs-main.ts#L5344) |
| XLSX | `propose_operations` 提供 add_sheet、set_range、结构与格式操作；`create_document` 可导出当前单张工作表，也可把 HTML 报告交给 Docs 创建。[工具与导出语义](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/office-xlsx/vendor/apps/sheets/src/renderer/ai/tools.ts#L492) | 该 create_document 的 xlsx/csv 分支只带当前显示值，公式与格式不保留。正式生成复杂工作簿应复用 workbook 操作和完整保存能力，不能误用单表快照导出。 |
| PPTX | `generate_deck` 提供提纲、风格、逐页生成及插入流程；有 execute_slide_script 和布局审计。[上游已锁定源码](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/office-pptx/vendor/apps/slides/src/renderer/ai/slides-skill.ts#L577) | 生成依赖规划、页面生成、图片搜索等 deps；云端能力/账户依赖须逐项核查，不能假设都能直接用现有模型配置。可先复用本地布局/操作/保存，再逐步适配整套生成编排。 |

本项目当前刻意移除了 GenOffice 的重复 AI 面板/独立聊天，并非所有上游 AI 工具都已开放。`office-service.mjs` 只注册 `file_office_inspect` 和 `file_office_edit`，后者明确限简单内容修改，不支持字体、样式、页面结构。[当前助手工具](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/dsh-assistant/scripts/office-service.mjs#L51)、[Word AI 面板替换](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/office-docx/renderer-build.mjs#L168)、[PPT AI 排除](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/office-pptx/excluded-ai.tsx#L1)

本地另有已适配的 `office-html2docx` 浏览器 helper，接受 HTML 并返回 `Uint8Array`，运行时不依赖 Electron/Node/Playwright，但当前用途是 altChunk 导入；可以作为 DOCX 创建实现候选，尚未实测它满足整篇新建文档的分页、字体、样式和媒体需求，不能直接宣称拿来即用。[包契约](https://github.com/xuchen-cloud/project_mind/blob/3b1c19ed1ecb6e49d481f7050235f419f56d7c53/packages/office-html2docx/README.md#L1)

### 推荐架构

`用户请求 → 现有助手解析内容/结构 → GenOffice 生成或操作能力 → 候选 Office 字节 → 原生 File create/update 提交 → 原生收据与固定版本 → inspect/读回验收`

- 助手继续使用 Project Mind 的上下文、会话和模型配置；提取上游工具 schema、writer/pipeline 与格式能力时，替换其宿主/模型调用依赖。
- 创建入口明确新建目标 scope/safeName；更新入口明确已有 ObjectRef + version/hash。两者不靠同名推断，也不通过先造假占位文本 File 再替换来实现。
- 二进制创建的 staged target 需要独立 create 形态，不伪造已有 File 基线。共用字节暂存、大小/hash 校验、恢复和最终提交边界，完成一次原子创建及稳定 requestId 回执。
- GenOffice 解决内容生成和格式处理；正式二进制创建解决原生持久化。两者是上下游关系，不能互相替代。
- 可以在内部私有草稿/候选区域完成生成再发布 v1，避免失败时向用户留下空白占位 File。若选择可见流式草稿，应另行定义取消、部分保留及何时产生已保存版本。
- 不要求通过 UI 点击或独立 GenOffice 窗口完成自动化；生成适配是否能无可见编辑器运行，需要具体实现和验证，当前不作为已交付能力。

## 优先级与实施切片

用户所列 P0 更适合解释为“阻塞本次 Office 任务”，目前没有证据支持升级为全产品宕机/数据损坏级事故。仍建议将 references 路由和 Office 创建闭环列为近期最高优先级。

| 次序 | 工作包 | 最小验收 |
| --- | --- | --- |
| 1 | references 路由 + 精确错误原因 + Skill 边界 | 新 Session 能读取主 Skill、递归 references；授权外业务文件仍被拒绝；DOCX list 明确 unsupported 而非等待。 |
| 2 | GenOffice DOCX 生成 + 正式二进制 create/import | 从用户请求生成有标题/中文/列表/表格的 DOCX，拿到原生 File ID、v1、hash 和创建回执；同 requestId 重试不重复建；失败无假成功或可见半成品。 |
| 3 | Office 验收与完整契约 | 固定版本 inspect、hash 比对、编辑 v2、陈旧 CAS 拒绝、重新打开验证；覆盖 Workspace/Project、中文及空格路径。 |
| 4 | 三类 list 统一简写、binary download、Office 内容投影/搜索 | 简写和 JSON 使用同一 DTO/校验；下载字节一致；Office 搜索明确格式定位、截断及覆盖范围，不把未抽取当无匹配。 |
| 5 | XLSX/PPTX 的完整生成编排、删除/主动变更事件 | 按各格式真实能力逐项验收，尤其 XLSX 公式/格式、PPT 页数/布局和生成依赖；删除另定授权。 |

Skill 配方应在对应接口真实可用后更新，不提前写出不存在的命令，也不把目录投放作为正式创建的默认路径。目录发现可记录为兼容入口，并明确它缺少 CLI 创建回执闭环。

## 环境与 OOXML 反馈

pandoc 的 CPU 架构不匹配、python-docx 缺失属于用户当次环境的待核实信息；不应要求每次 Office 任务现场选装生成器。复用打包的 GenOffice 能力可减少这些外部依赖。

缺少 `styles.xml` 本身并不等于 DOCX 非法。Microsoft 的最小结构说明和官方样式说明确认 styles part 并非有效文档的必要条件。中文字体选择、语义样式、分页和跨编辑器兼容仍需要单独验收，不能用“长得像 Word 生成的包”代替。[最小 package](https://learn.microsoft.com/en-us/office/open-xml/general/how-to-create-a-package)、[官方样式说明](https://github.com/OfficeDev/office-content/blob/main/en-us/OpenXMLCon/articles/8d465a77-6c1b-453a-8375-ecf80d2f1bdc.md)

## 本次验证

- 静态跟踪 CLI 参数解析、File create/upload、Skill 读取中间件、Office inspect/edit、通用文本抽取、目录发现和固定版本读取；结论均对应固定提交。
- 从 develop 提取未经修改的 `source-bridge.mjs`、既有测试及其读取 fixture 到临时目录，用 Node v22.18.0 运行既有 source bridge 测试：8/8 通过，无应用窗口。
- 另做最小中间件探针：读取 `/bundle/skills/project-mind-cli/references/record-file.md` 仍发出 native `prepare`，原始 read fallback 次数为 0，并传播 `File belongs to another scope`。这验证读取路由问题；native 的拒绝由源码解释，探针未访问用户业务数据。
- 通过 GitHub API 读取锁定上游的 Word 工具、writer、main 创建流程及既有测试；测试文件用于核对语义，本次未执行上游 GenOffice 全套或真实生成验收。
- 未运行本地 GUI、全量编译或用户 Workspace 读写；没有对现有业务源码作修改。
