# P0 视觉内容计划

- 产品基线：`9b359e83e76bf35bee7d46a9a97659af3916f784`
- 规划日期：2026-08-21
- 统一案例：`客户成功` Workspace / `智能客服知识库升级` Project
- 当前状态：仅预留位置与拍摄说明，由用户后续统一截图或制作示意图

## 拍摄与制作约定

- 产品界面必须来自真实运行的基线应用，不生成或重绘虚假 UI。
- 截图只保留它要证明的界面区域；同组连续图使用相同窗口尺寸、数据和缩放比例。
- 隐去本机真实路径、个人姓名、API Key、系统通知和其他 Workspace 数据。
- 菜单或对话框截图必须保留触发对象，使读者看得出“从哪里打开”。
- 示意图使用 Mermaid 或可编辑 SVG；暖白、浅灰、克制蓝绿色，不模拟产品 UI。
- 图片最终保存到 `docs/help/assets/` 下对应分组目录。状态从 `pending-user-capture` 更新为 `captured`，完成正文核对后再标记 `verified`。
- 补图不是机械替换占位符。每张图片加入后都要重读其前一个标题到后一个标题之间的正文：真实界面与文字冲突时以基线界面为准；图片已经清楚证明的位置或状态不再用长段落重复；正文仍需写出动作、结果与无障碍可理解的信息。
- 每个正文 `VISUAL` 注释中的 `text-review` 指定补图后必须重新核对的文字范围。未完成该范围的图文联审时，即使文件已经存在，也只能标记为 `captured`。

## 视觉清单

| ID | 文章与插入位置 | 类型 | 要证明的问题 | 截图 / 制图说明 | 目标文件与 alt | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| P0-HOME-01 | `README.md` 开场之后 | 真实 UI 全景 | Project 的 Record、QuickNote、File 与 Todo 如何处于同一工作现场 | 打开“智能客服知识库升级”Project；主区显示一条有内容的 Record，左侧可见 Record/File 入口，右侧显示 Project Todo；不要打开菜单 | `assets/overview/workspace-overview.png`；alt：`智能客服知识库升级 Project 的 Record、File 与 Todo 工作现场` | pending-user-capture |
| P0-START-01 | `10-minute-start.md` 第 1 步之后 | 真实 UI 截图 | 新用户从哪里创建或打开 Workspace | Workspace Gate 全窗口；最近列表使用虚构路径或裁掉路径列；突出“新建 Workspace”“打开已有 Workspace” | `assets/getting-started/workspace-gate.png`；alt：`Workspace Gate 中的新建、打开和最近 Workspace 入口` | pending-user-capture |
| P0-START-02 | `10-minute-start.md` 第 3 步之后 | 真实 UI 截图 | 新 Project 的 QuickNote 在哪里写、完成后是什么状态 | 打开“智能客服知识库升级”Project 的 QuickNote；正文只放目标和当前判断；左右侧栏同时可见 | `assets/getting-started/project-quicknote.png`；alt：`智能客服知识库升级 Project 的 QuickNote 与 Todo List` | pending-user-capture |
| P0-START-03 | `10-minute-start.md` 第 4 步之后 | 真实 UI 截图 | 新建 Record 后专注页和保存状态是什么样 | 显示“高频问题初步盘点”标题、两行示例正文和“已保存”；裁掉真实路径 | `assets/getting-started/first-record.png`；alt：`高频问题初步盘点 Project Record 的专注页和已保存状态` | pending-user-capture |
| P0-START-04 | `10-minute-start.md` 第 6 步之后 | 真实 UI 状态对照 | Todo 与 Record 离开后仍能找回 | 左半为 Workspace View 中的 Project Todo，右半为 Project 记录侧栏中的“高频问题初步盘点”；使用同一组数据 | `assets/getting-started/find-record-and-todo.png`；alt：`在 Workspace View 与 Project 记录侧栏再次找到 Todo 和 Record` | pending-user-capture |
| P0-WORKSPACE-01 | `workspace.md` 创建步骤之后 | 真实 UI 连续步骤 | Workspace Gate 与创建对话框的对应关系 | 两幅连续图：Gate 点击“新建 Workspace”前；创建对话框已选虚构根目录、密码用圆点遮挡、创建按钮可用 | `assets/getting-started/create-workspace.png`；alt：`从 Workspace Gate 打开新建 Workspace 对话框` | pending-user-capture |
| P0-SCOPES-01 | `scopes-and-views.md` 页面范围表之后 | 示意图 | Workspace/Project 归属与 Todo View 为什么不是一回事 | 外层 Workspace；包含 Workspace Record/Todo/Tag 与两个独立 Project；Workspace View 用虚线汇集 Workspace Todo 和未 Archive Project Todo；Current Project View 只圈当前 Project Todo；标注“View 不改变归属” | `assets/diagrams/scope-and-todo-views.svg`；alt：`Workspace 与 Project 对象归属及两种 Todo View 的关系` | pending-user-capture |
| P0-PROJECTS-01 | `projects.md` Archive 操作之后 | 真实 UI 状态对照 | 从哪里 Archive，以及从哪里恢复 | 左图为活跃项目右键“项目操作”菜单，右图为“归档项目”对话框中的“打开”“恢复”；使用同一 Project | `assets/getting-started/archive-and-restore-project.png`；alt：`Project 的归档菜单与归档项目恢复对话框` | pending-user-capture |
| P0-PROJECTS-02 | `projects.md` 三种动作表之后 | 示意图 | 关闭页签、Archive、删除的后果差异 | 三条路径从“活跃 Project”出发：关闭页签→仍在活跃列表；Archive→移出活跃范围且可恢复；删除→移入废纸篓且产品内无恢复入口 | `assets/diagrams/project-lifecycle-actions.svg`；alt：`关闭页签、Archive 与删除 Project 的状态变化` | pending-user-capture |
| P0-QUICKNOTE-01 | `quicknote.md` 入口选择之后 | 真实 UI 状态对照 | Workspace QuickNote 与 Project QuickNote 的入口和归属差异 | 同尺寸双图；左为 Workspace 顶栏和 Workspace QuickNote，右为“智能客服知识库升级”页签和 Project QuickNote；正文各放一条易区分示例 | `assets/capture/workspace-vs-project-quicknote.png`；alt：`Workspace QuickNote 与 Project QuickNote 的入口对照` | pending-user-capture |
| P0-RECORD-01 | `record.md` 创建步骤之后 | 真实 UI 连续步骤 | 如何从记录侧栏新建并确认保存 | 三段连续状态：左侧“新增记录”入口、Record 专注页编辑状态、页头“已保存”；使用 Project Record | `assets/capture/create-and-save-record.png`；alt：`从 Project 记录侧栏新建 Record 并确认已保存` | pending-user-capture |
| P0-SEARCH-01 | `search.md` 三层搜索说明之后 | 真实 UI 三联图 | 正文查找、当前侧栏筛选、Workspace 搜索的范围差异 | 同一个关键词“支付流水”：编辑器 Cmd/Ctrl+F；Project 记录侧栏筛选；切回 Workspace 后的顶栏搜索结果；每图只突出搜索框与结果 | `assets/context/search-three-levels.png`；alt：`在当前正文、Project 记录侧栏和 Workspace 顶栏逐步扩大搜索` | pending-user-capture |
| P0-DECISION-01 | `record-or-todo.md` 判断表之后 | 示意图 | 一段内容如何流向 QuickNote、Record 或 Todo | 起点“这条内容现在是什么”；未想清楚→QuickNote；需保留判断→Record；需跟踪完成→Todo；同一句包含判断和行动时分成 Record+Todo | `assets/diagrams/quicknote-record-todo-decision.svg`；alt：`在 QuickNote、Record 与 Todo 之间判断内容去向` | pending-user-capture |
| P0-TODO-01 | `todo-scope.md` 两种创建路径之后 | 真实 UI 状态对照 | Current Project View 与 Workspace View 创建 Todo 时归属控件为何不同 | 左图 Project 页面 Current Project View，新建框不显示归属；右图 Workspace View，新建框显示“Todo 归属”且展开 Project 选择 | `assets/momentum/todo-scope-create.png`；alt：`Current Project View 与 Workspace View 创建 Todo 时的归属差异` | pending-user-capture |
| P0-FILES-01 | `project-files.md` 导入步骤之后 | 真实 UI 连续步骤 | File 导入和批量选择 Project Tag 的入口 | Project 左侧“文件”页签点击“导入文件”；随后“选择导入标签”对话框；文件名与 Tag 使用演示数据 | `assets/momentum/import-file-with-tags.png`；alt：`在 Project 文件页签导入 File 并选择 Project Tag` | pending-user-capture |
| P0-FILES-02 | `project-files.md` File Version 之后 | 真实 UI 状态对照 | 标星、File Version 与“失效”分别长什么样 | 一张正常标星 File 展开版本列表；旁边一张失效 File，显示“失效”且相关菜单禁用；不要截真实文件路径 | `assets/momentum/file-version-and-missing.png`；alt：`Project File 的标星版本列表与失效状态` | pending-user-capture |
| P0-AI-01 | `overview.md` 明确目标步骤之后 | 真实 UI 状态对照 | 文字与图片 AI 从哪里启动 | 左图明确文字选区的右键菜单，右图单张图片的右键菜单；只显示已启用的演示 Skill，不出现真实 Provider/Key | `assets/ai/text-and-image-skill-entry.png`；alt：`文字选区与单张图片的 AI Editor Skill 入口` | pending-user-capture |
| P0-AI-02 | `overview.md` Provider 边界之后 | 示意图 | 哪些内容留在本地，何时发送到 Provider | 左侧本地 Workspace/Committed Content；中间用户主动运行 Skill；右侧外部 Provider；文字路径标出完整 Markdown 块，图片路径标出单图、标注与有限附近正文；返回结果先进入待确认区 | `assets/diagrams/local-ai-provider-boundary.svg`；alt：`Project Mind 本地内容与外部 AI Provider 的数据流边界` | pending-user-capture |
| P0-DATA-01 | `local-data.md` 数据边界说明之后 | 示意图 | Workspace 内容、应用配置和外部 Provider 之间的存储边界 | 左侧为用户选择的 Workspace 目录，包含 Record、QuickNote、Todo、File 元数据与 Project 信息；中间为本机应用配置；右侧为仅在用户主动运行 AI Skill 时接收所选内容的外部 Provider；用箭头区分“本地保存”和“主动发送” | `assets/diagrams/workspace-storage-boundary.svg`；alt：`Workspace 内容、本机应用配置与外部 AI Provider 的存储边界` | pending-user-capture |
| P0-TROUBLE-01 | `troubleshooting.md` 开场之后 | 真实 UI 四状态拼图 | 用户如何识别四类高频异常状态 | 四格：正文“保存失败”、File“失效”、AI 配置锁定、Record Export 图片无法读取；只保留状态区域与恢复入口，不含真实数据 | `assets/trust/troubleshooting-states.png`；alt：`保存失败、File 失效、AI 锁定和导出图片错误的界面状态` | pending-user-capture |

## 完成检查

- [ ] 所有截图均来自锁定基线的真实产品界面。
- [ ] 所有视觉与相邻正文使用同一演示数据和界面名称。
- [ ] 所有真实路径、姓名、API Key、系统通知和无关内容已脱敏。
- [ ] 所有图片文件存在，尺寸足以读清关键文案，未截入大片无关空白。
- [ ] 所有 Markdown 图片 alt 与本表一致或更具体。
- [ ] 所有示意图源文件可编辑，导出结果在浅色背景下清晰。
- [ ] 每张图确实回答相邻正文的一个问题，没有仅作装饰的图片。
- [ ] 每个视觉位的 `text-review` 范围已按最终图片重新编辑，菜单名、步骤、状态和图片一致。
- [ ] 正文没有逐字复述图片，也没有把只能从颜色或方位判断的信息留给图片单独承担。
