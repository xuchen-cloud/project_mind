# Project Mind

Project Mind 帮助个人在长期工作空间中组织阶段性项目，使当前理解、历史依据和下一步行动保持在同一上下文内。

## Language

### 工作边界

**Workspace**：
长期存在的工作与知识边界，承载跨项目或不属于任何阶段性项目的持续积累。
_Avoid_：Project、Area、临时项目

**Project**：
围绕一个明确结果建立的阶段性工作现场，有开始、推进和结束；没有完成终点的长期责任或知识领域不属于 Project。
_Avoid_：Workspace、Area、长期领域

**Archive**：
让 Project 可逆地退出活跃工作范围的状态变化，不表示该项目已经完成，也不删除项目及其内容。
_Avoid_：Complete、Delete、项目结束

**Project Label**：
直接附着在 Project 上的多值自定义分类，用于表达项目类型、优先级等非生命周期属性。
_Avoid_：Project Tag、Project Status、Archive

**Project Status**：
Project 在生命周期中任一时刻唯一的自定义状态，例如“计划中”“进行中”或“已完成”；它独立于 Project Label 和 Archive。
_Avoid_：Project Label、Project Tag、Archive

### 信息沉淀

**QuickNote**：
特定作用域中唯一的可变信息缓冲区，用于立即记下尚未决定最终形式或沉淀位置的内容。
_Avoid_：Daily Note、Record、正式归档

**Workspace QuickNote**：
Workspace 中唯一的低摩擦捕捉缓冲区，可以暂存想法、简要规划和候选行动；内容只有在用户决定长期保留或持续跟踪后，才转化为 Record 或 Todo。
_Avoid_：状态看板、Daily Note、Todo List

**Project QuickNote**：
Project 中唯一的低摩擦捕捉缓冲区，用于暂存已经明确属于该项目、但尚未决定是否沉淀为 Project Record 或 Project Todo 的内容。
_Avoid_：项目状态摘要、Project Record、Project Todo

**Record**：
已经判断值得保留、可以独立查找和引用的信息单元；它具有相对完整的上下文，可以继续修订，但不再是待处理的临时片段。
_Avoid_：Note、Activity、Conclusion（对象）、QuickNote

**Project Record**：
归属于一个 Project 的 Record，用于保存该项目中的事件、材料、观察或判断，其生命周期与所属 Project 一致。
_Avoid_：Workspace Record、跨项目记录

**Workspace Record**：
不归属于某个阶段性 Project、没有预定结束时间的长期 Record，用于沉淀方法、框架、跨项目经验或持续关注的领域内容。
_Avoid_：Project Record、Area

### 行动

**Todo**：
需要被跟踪直至完成的明确行动，按照归属分为 Workspace Todo 和 Project Todo。
_Avoid_：Task、Record、QuickNote

**Project Todo**：
归属于某个 Project、用于推进该项目结果的 Todo，其生命周期与所属 Project 一致。
_Avoid_：Workspace Todo、跨项目 Todo

**Workspace Todo**：
直接归属于 Workspace、不依赖任何 Project 的 Todo，用于个人事务、跨项目事项或不需要建立 Project 的行动。
_Avoid_：Project Todo、未归类 Project Todo

**Workspace View**：
以 Workspace 当前工作范围为尺度查看 Todo 的集合，包含 Workspace Todo，以及归属于未进入 Archive 的 Project 的 Project Todo；它可以在 Workspace 或任一 Project 中查看，不改变其中任何 Todo 的归属。
_Avoid_：Workspace Todo、仅 Workspace Todo、Todo 归属

**Current Project View**：
以当前 Project 为尺度查看 Todo 的集合，只包含归属于当前 Project 的 Project Todo，不包含 Workspace Todo 或其他 Project 的 Project Todo。
_Avoid_：Workspace View、Workspace Todo、跨 Project Todo

**Subtask**：
Todo 下可独立安排和完成的较小行动单元，可以有自己的完成状态、截止日期和顺序。
_Avoid_：Todo Progress、进展、子项

### 材料

**File**：
归属于一个 Project、被该工作现场持续管理的外部材料，可以被查找、引用、标记并随内容变化保留版本。
_Avoid_：Document、附件记录

**File Version**：
同一个 File 在特定时点的内容版本，依附于该 File，不是新的独立 File。
_Avoid_：Document Version、独立 File

### 组织

**Tag**：
在单一作用域内对内容进行轻量分类和连接的标记，不形成层级，也不创造新的内容容器。
_Avoid_：Folder、Area、全局标签

**Workspace Tag**：
只用于 Workspace 范围对象的 Tag，不能附着到任何 Project 或 Project 范围对象。
_Avoid_：Project Tag、跨项目标签、全局标签

**Project Tag**：
只用于一个特定 Project 内 Record、Todo 和 File 的 Tag，不能跨 Project 或用于 Workspace 范围对象。
_Avoid_：Workspace Tag、跨项目标签、全局标签

**Internal Reference**：
对象之间可导航的上下文连接，不改变目标对象的归属或标签作用域。Workspace 范围对象可以引用 Project 对象；Project 范围对象只能引用同一个 Project 内的对象，不能引用 Workspace 或其他 Project。
_Avoid_：Tag、归属关系、跨 Project 引用

**Contact**：
Workspace 中可复用的人员信息，可以被 Workspace 和各 Project 范围的内容提及。
_Avoid_：User、Assignee、Project Contact

**Contact Mention**：
内容中指向 Contact 的上下文连接，用于表达人员相关性，不表示负责人、执行者或权限关系。
_Avoid_：Assignee、任务分配、权限授予

### AI 编辑

**AI Editor Skill**：
归属于 Workspace、可在 QuickNote 和 Record 编辑器中复用的用户自定义编辑能力，由名称、说明和提示词表达意图，并可分别适用于文字和图片菜单。
_Avoid_：AI Artifact、Ask、固定结果模式

**Image Interpretation**：
AI Editor Skill 对编辑器中一张图片的内容进行理解并生成文字结果，图片本身始终保持不变。
_Avoid_：图片编辑、图片修改、像素编辑

**AI Modification**：
AI 针对选中内容提出的替换建议，只有在用户明确接受后才成为正文。
_Avoid_：自动改写、已保存内容

**AI Answer**：
AI 根据选中内容生成的补充回答，只有在用户明确插入后才成为正文。
_Avoid_：Ask、AI Artifact、已保存内容

**Editor Skill Job**：
AI Editor Skill 针对一个显式文字选区或一张图片运行的一次临时会话，承载待确认的 AI Modification 与 AI Answer。
_Avoid_：图片 Job、持久化 AI 历史、编辑器全局会话

**Committed Content**：
编辑器中已经由用户确认、允许保存的正文视图，不包含任何仍待确认的 AI Modification 或 AI Answer。
_Avoid_：实时预览内容、编辑器 DOM 快照

**AI Metadata Fill**：
用户在 Record 标题区域显式发起、以 Committed Content 和同作用域现有 Tag 为输入的一次 AI 填写操作；它生成标题并优先复用现有 Tag，必要时新增少量 Tag，成功后以一个原子变更写入 Record。
_Avoid_：AI Editor Skill、AI Answer、自动后台分类、跨作用域 Tag 推荐

### 内容携带

**Record Export**：
单条 Workspace Record 或 Project Record 在其 Committed Content 状态下形成的本地可携带副本，可表现为 Markdown/ZIP、DOCX 或 PDF，但不改变原 Record。
_Avoid_：Backup、Workspace Export、未确认内容快照
