# Project Mind：打开速度、保存可靠性与数据丢失风险检视

- 用户请求：安装 wshobson/agents 的 full-review 并检视当前项目。
- 基线：`fe9fe9c188f05c23bae369074446e38c0859a0c8`，2026-11-10。
- 关联 Issue：本次为用户直接发起的本地审查，未关联新 Issue。
- 依赖：当前实现、领域与保存规格、已有测试和性能工具。用户已明确同意 review 子 agent。
- 交付：有文件位置、触发条件、影响和验证依据的发现，以及按风险排序的建议。
- 非目标：本轮不实施业务源码修复、不发布、不更改用户工作区数据。
- 验收：追踪启动/打开/编辑/保存/关闭恢复的真实路径；区分代码确定缺陷、可复现实验和未测量的性能风险；核对现有 CAS、原子落盘、回执与恢复保障；形成完整报告。
- 验证范围：静态调用链与针对性无界面测试，必要时用临时 fixture 复现具体问题；不以单元测试代替安装包或 Windows 实机证据。

## Files

- 启动与 Workspace：`src/main.tsx`、`src/App.tsx`、`src-tauri/src/lib.rs`、`workspace_startup.rs`、`workspace_initialization.rs`、`workspace.rs`、`db.rs`。
- Record：`src/lib/record-save-*`、`record-focus-save.ts`、`quick-note-transfer.ts`、Record 页面与 hooks；`src-tauri/src/record_document_*`、`record_editor_coordination.rs`、`db/record_documents.rs`。
- File/Office/Markdown：`src/components/document/`、`src/components/office/`、`src/components/project/ProjectContent*`、`src/lib/file-edit-session.ts`、`project-content-lifecycle.ts`；`src-tauri/src/file_*`、`db/file_*`、`workspace_commit_fence.rs`；相关格式包保存桥接。
- 数据恢复与边界：数据库启动/迁移、文件写入 intent、版本恢复与退出协调；必要时追踪调用方。
- 验证与规格：对应测试、`scripts/office-performance/`、`docs/system-design.md`、`docs/cache-strategy.md`、`docs/implementation/file-save-sessions.md`、`file-working-content-notes.md`、`office-continuous-formats.md`、`xlsx-continuous-save.md`、相关 ADR 与 requirements。
- 已有两份未跟踪的 2026-10-28 报告作为历史线索，结论必须重新核验当前代码。

## Flags and phases

- Performance critical：yes；security focus：限保存权限、身份和数据完整性；strict mode：no；framework：React / Tauri / Rust / SQLite。
- 阶段顺序：质量与架构 → 安全与性能 → 上游 approval checkpoint → 测试与文档 → 框架与运维约束 → 汇总。
- 仓库无 CI 是已记录的项目决策，不作为缺陷；无关风格、通用云平台建议和假设中的未来规模不列入发现。

## Environment

- 开始时没有 tauri dev / Vite 自动重启进程。
- 用户随后明确允许启动可见应用窗口进行完整检查。真实应用验证由主 agent 串行执行，使用临时工作区。

## Office 打开方式补充

- 用户明确希望：先打开可用文档首屏，再逐步加载剩余页面/工作表，检查是否被完整文件读取、完整解析、全量模型传输或整篇渲染阻塞。
- 检视进入 Office 开源格式引擎、renderer、宿主协议与构建适配代码；用户允许在后续修复中修改这些源码，并非将开源包视为不可修改黑盒。
- 渐进加载建议必须保持未加载内容的完整保存、固定基线、累计修改、CAS 与版本/回执不变量。本轮交付仍为审查证据与具体改进方案。

## 用户报告的回归

- 引入 Record 块后，保存经常间歇报错；追踪 canonical body、版本、metadata 和保存协调竞争。
- 引入块后行距明显变大；比较旧版段落与块容器的 line-height、margin、gap 叠加和空段落处理。
- 上次性能修改后 Windows 语音记录再次失败，用户确认在「点击开始录音时」发生，疑似数据库错误。检查开始录音的 draft/DB 初始化与近期性能改动；本机 macOS 证据不能代替 Windows 实机复现。
