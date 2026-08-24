# 把散落 File 变成可找回的项目现场

需要持续支撑一个 Project 的外部材料，应作为 File 导入该 Project。之后从 Project 左侧栏的“文件”页签，按名称、Project Tag 或标星找回；File 缺失或有多个版本时，也在这里判断下一步。

以下示例把“退款问题口径草案.pdf”留在“智能客服知识库升级”Project，作为“整理退款进度类问题的标准答案”这条 Project Todo 的行动依据。

## 1. 把 File 导入正确的 Project

1. 打开“智能客服知识库升级”Project。
2. 在左侧栏点击“文件”。
3. 点击搜索框旁的“导入文件”，选择“退款问题口径草案.pdf”。你也可以把本地文件拖到这个 Project 的左侧栏，看到“松手即可导入文件”后松开。
4. 如果出现“选择导入标签”，选择适用于这批 File 的 Project Tag，例如“退款问题”，再点击“开始导入”。不选 Tag 也可以。

一次选择多个 File 时，这里选中的 Tag 会应用到本批全部 File。导入完成后，File 由当前 Project 持续管理；它不会成为 Workspace 范围的对象。

导入 Project 外的文件时，来源会被复制；如果来源已经位于该 Project 内、但不在受管位置，来源可能被移动。若原路径必须保留，请先在原位置保留一份副本，再导入用于 Project 管理的文件。

<!-- VISUAL P0-FILES-01
type: 真实 UI 连续步骤
capture: “智能客服知识库升级”Project 左侧“文件”页签中的“导入文件”入口；随后出现的“选择导入标签”对话框。使用“退款问题口径草案.pdf”和“退款问题”Project Tag。
purpose: 证明 File 必须从目标 Project 导入，以及批量 Tag 在导入前选择。
asset: ../assets/momentum/import-file-with-tags.png
alt: 在 Project 文件页签导入 File 并选择 Project Tag
text-review: 补图后复核导入四步和复制/移动风险提示；如果对话框只在已有 Project Tag 时出现，正文必须继续保留这个条件。
status: pending-user-capture
-->

## 2. 用名称、Project Tag 或标星找回

已知名称时，在“搜索文件或标签”中输入“退款”；搜索会匹配 File 名称和 Project Tag 文本。只记得分类时，直接点击搜索框下方的“退款问题”Tag 筛选。

需要反复打开某个 File 时，右键它并选择“标星”。标星 File 会排在未标星 File 前面；右键选择“取消标星”即可恢复。

这些搜索、Tag 和标星都发生在当前 Project 内，不会把 File 暴露到其他 Project。

## 3. 打开 File，或定位它在系统中的位置

- 点击正常 File，打开当前内容。
- 需要在系统文件管理器中找到它时，右键 File，选择“打开文件所在位置”。

“打开文件所在位置”只负责定位当前受管 File，不会改变它的 Project 归属，也不会替换它的路径。

## 4. 看见“失效”时，不要把它当成可打开的 File

File 的当前路径不可用时会显示“失效”。此时点击它会提示重新导入；“打开文件所在位置”和创建新版本也不可用。

当前版本没有可见的“重新定位”入口，不能把另一条路径直接接回原 File。若仍需使用这份材料，请确认外部来源有效，再通过“导入文件”以不同文件名导入为新的 File。旧的失效条目不会自动修复；需要清理旧条目时，请先看[遇到问题时先检查什么](../trust-and-help/troubleshooting.md)，避免误删仍需保留的版本依据。

## 5. 用 File Version 保留可回看的版本

如果要基于当前内容继续修改：

1. 右键 File，选择“复制为新版本并打开”。
2. Project Mind 会复制当前内容，创建下一版并打开它。
3. File 出现 `v2`、`v3` 等版本号后，点击版本号查看版本列表。
4. 选择旧版本可以打开当时的内容，用来核对历史依据。

打开旧 File Version 不等于回滚，也不会把旧版恢复为当前版。`File Version` 依附于同一个 File，不是新的独立 File。

<!-- VISUAL P0-FILES-02
type: 真实 UI 状态对照
capture: 左侧为正常且已标星的 File，展开 v2/v3 版本列表；右侧为同组演示中的失效 File，显示“失效”，并让相关菜单的禁用状态可辨认。不要截入真实文件路径。
purpose: 证明 File Version 是同一 File 的历史内容，而“失效”是路径不可用的另一种状态。
asset: ../assets/momentum/file-version-and-missing.png
alt: Project File 的标星版本列表与失效状态
text-review: 补图后共同复核“看见失效”和“用 File Version”两节；以截图校正版本入口、菜单状态和失效文案，避免把打开旧版写成恢复或回滚。
status: pending-user-capture
-->

## 接下来

- 上一级：[让 Project 继续向前](README.md)
- 上一步：[把 Todo 放回真正属于的地方](todo-scope.md)
- 下一步：[AI 能做什么，不能做什么](../thinking-with-ai/overview.md)
- 相关：[从当前内容开始逐步扩大搜索](../context/search.md)

<!-- last-reviewed: 9b359e83e76bf35bee7d46a9a97659af3916f784 / 2026-08-21 -->
