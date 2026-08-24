# Capture / Momentum 跨组编辑审校

- 审校日期：2026-08-21
- 产品基线：`9b359e83e76bf35bee7d46a9a97659af3916f784`
- 范围：`capture/quicknote.md`、`capture/record.md`、`context/search.md`、`momentum/record-or-todo.md`、`momentum/todo-scope.md`、`momentum/project-files.md`
- 结论：0 个 P0、1 个 P1、3 个 P2、1 个 P3。

## Standards

### P1 — File 导入步骤没有就地说明来源文件可能被移动

- 位置：`docs/help/momentum/project-files.md:9-14`
- 发现：文章只说明导入后 File 会由 Project 持续管理，没有在导入动作旁说明已位于 Project 内、但不在受管目标位置的来源文件可能被移动。`facts-momentum.md` 已把普通导入的复制/移动语义列为事实，`PLAN.md` 又要求移动语义进入核对表并把风险放在相关步骤附近。用户若依赖原路径，可能在导入后才发现路径变化。
- 具体修改建议：在第 14 行后就地补充提示，例如：“导入 Project 外的文件时会复制来源；来源已经位于该 Project 内、但不在受管位置时，可能会被移动。若原路径必须保留，先复制一份再导入。”不要笼统承诺导入永远不移动来源。

### P2 — `Workspace View` 被误用于描述 Record 的查看位置

- 位置：`docs/help/capture/record.md:12`
- 发现：`Workspace View` 是 Todo 的正式查看范围，不是 Workspace 页面或 Record 视图的泛称。把“从 Workspace View …看到 Record”写入 Record 文章，会混淆 Record 归属与 Todo View。
- 具体修改建议：改为直接说明创建入口决定归属，例如：“Record 的归属由创建入口决定：在 Workspace 的‘记录’中创建 Workspace Record，在目标 Project 的‘记录’中创建 Project Record；之后查看它不会改变归属。”

### P2 — 两处链接文字与现有目标文章标题不一致

- 位置：`docs/help/capture/quicknote.md:34`；`docs/help/momentum/todo-scope.md:57`
- 发现：两处链接文字都是“看懂界面、归属与 View”，现有目标 `docs/help/getting-started/scopes-and-views.md:1` 的标题是“看懂归属与 Todo View”。目标存在，因此这不是“计划内链接尚未创建”的问题，而是当前链接标题漂移。
- 具体修改建议：由开始使用组确定最终权威标题后，同步目标 H1、`PLAN.md` 清单与这两处链接文字；发布前确保三处完全一致。

### P3 — Capture / Search 三篇缺少基线复核标记

- 位置：`docs/help/capture/quicknote.md:36`；`docs/help/capture/record.md:45`；`docs/help/context/search.md:52`
- 发现：三篇页尾没有记录最后核对版本/日期，而 Momentum 三篇已有统一的隐藏标记；这不影响当前操作，但会削弱后续按基线定向复核的可维护性。
- 具体修改建议：在三篇页尾加入与 Momentum 组一致的 `<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->`。

## Spec

### P2 — QuickNote 保存失败后的“重试”没有给出可执行动作

- 位置：`docs/help/capture/quicknote.md:18`
- 发现：“保留当前内容并重试”没有说明怎样重试；QuickNote 没有显式“保存”按钮。正常保存触发条件写得清楚，但风险分支停在不可执行的指令，不符合操作步骤与排障应提供准确下一步的要求。
- 具体修改建议：把失败分支改成可观察、可重复的路径，例如：“保持应用打开，重新聚焦编辑区并做一次小改动，再离开编辑区以触发保存；看到成功反馈后再关闭。仍失败时转到《遇到问题时先检查什么》。”在排障文章完成前，可先保留文字步骤而不发布失效链接。

## 已检查且未发现问题

- 事实证据：QuickNote 唯一缓冲区与约 120 秒自动保存、Record 创建与保存、三层搜索范围、Todo 归属与两个 View、Project File 导入/筛选/失效/版本行为，除上述发现外均能由共享事实表及锁定基线支持。
- 术语与作用域：未把 QuickNote 写成 Daily Note，未把 File 写成附件或 Document，未把 Workspace View 写成仅 Workspace Todo，未宣称 QuickNote 可一键转 Todo、File 可跨 Project、缺失 File 可重新定位或旧 File Version 可回滚。
- 发布范围：未发现 Ask、Brief、AI Artifact、Activity、Conclusion 或其他 P1/P2 能力被误写为正文中的已发布操作；`project-files.md` 对 `connections.md` 的相关链接只列入下方最终链接复核。
- 案例连续性：Capture 组沿“退款失败 / 失败码 3107”连续推进，Momentum 组沿“退款进度类问题的标准答案”连续推进；两组共用“智能客服知识库升级”Workspace / Project，没有制造冲突归属或跨 Project Internal Reference。
- 答案与步骤：六篇首段均先给结果或判断；主路径按可观察入口编排，删除、保存失败、File 失效和 File Version 非回滚等边界均已就地出现，除上述 QuickNote 重试与导入移动风险外未发现不可执行步骤。
- 重复与矛盾：QuickNote、Record/Todo 判断和 Todo View 在跨篇重复处承担独立文章入口所需的最小上下文，未发现相互矛盾的定义或整段步骤重复。

## 最终链接复核项（当前不判缺陷）

- 待其他组按计划创建后复核栏目入口：`docs/help/capture/README.md`、`docs/help/context/README.md`、`docs/help/momentum/README.md`。
- 待信任组创建后复核：`docs/help/trust-and-help/troubleshooting.md` 的标题是否为“遇到问题时先检查什么”，以及 `project-files.md:37` 的 File 缺失落点是否准确。
- 待组织组创建后复核：`docs/help/context/connections.md` 的标题是否为“给信息留下来龙去脉”。该页为 P1；若 P0 首发时仍未发布，应按 `PLAN.md:296` 暂不发布 `project-files.md:55` 的链接。
- 上述页面到位后运行全量 Markdown 链接检查，并复核栏目入口、上一篇/下一篇顺序及方法页双向链接。
