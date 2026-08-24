# “进入与第一次成功”编辑审校

审校范围：`docs/help/getting-started/*.md`。以下仅记录需要修改的发现；严重度按 P0（阻塞发布）至 P3（轻微编辑问题）排列。

## Standards

### P2 — 不要把点号目录无条件称为“隐藏目录”

- 文件与行号：`docs/help/getting-started/workspace.md:9`
- 发现：基线事实只证明创建名为 `.project-mind` 的目录。“隐藏目录”是平台相关表现，不是事实表支持的跨平台承诺；在 Windows 等环境中，点号前缀本身不保证目录具有隐藏属性。
- 具体修改建议：改为“Project Mind 会在根目录下建立 `.project-mind` 目录，并进入 Workspace 主界面”。如果确需说明它在文件管理器中的可见性，应先分别核验支持平台，再就地写平台差异。

### P2 — 面向用户的密码说明暴露了内部容器名

- 文件与行号：`docs/help/getting-started/workspace.md:18,24-28`
- 发现：“Workspace Secrets”不在 `CONTEXT.md` 的公开领域语言中，也不是用户理解解锁行为所必需的对象。它把实现边界带进了操作文章，并与“先结果后机制”的写作原则冲突。
- 具体修改建议：删除“Workspace Secrets”这个名称，直接描述可观察结果。例如第 18 行改为“打开后，已保存的 AI API Key 仍处于锁定状态；读取或保存 API Key 时才需要输入密码解锁”，第 26 行相应改为“它用于加密、解密保存在 Workspace 中的 AI API Key”。保留“不加密整个 Workspace”的边界。

### P2 — 把无障碍名称写成了 sighted 用户可见的按钮文案

- 文件与行号：`docs/help/getting-started/projects.md:15`
- 发现：基线中的 Project 页签关闭控件视觉上是关闭图标；“关闭 智能客服知识库升级”是 `aria-label`，正文却要求用户点击这段带引号的文字。对主要读者而言，这一步无法按所述界面文字定位。
- 具体修改建议：改为“点击顶栏中‘智能客服知识库升级’页签右侧的关闭图标”。如后续配图，用 alt 或标注说明该控件的无障碍名称即可，不要把 `aria-label` 当作可见菜单名。

### P3 — 首段混入内部验收口吻，削弱答案先行

- 文件与行号：`docs/help/getting-started/10-minute-start.md:3`
- 发现：“整个过程使用真实的新建 Record 入口”是在回应内部旧草稿风险，不是新用户的结果或操作条件；“真实”还会让读者疑惑是否存在另一种不真实的入口。
- 具体修改建议：删去“整个过程使用真实的新建 Record 入口”；保留对用户有意义的结果和边界，例如“QuickNote 会原样保留，Record 将单独新建”。

## Spec

### P1 — 第一次找回 Todo 的步骤依赖并不稳定的“分组显示”偏好

- 文件与行号：`docs/help/getting-started/10-minute-start.md:55`
- 发现：Workspace View 固定成立，但“按来源分组”不是必然状态；基线会持久化 Todo Rail 的 `grouped` / `flat` 显示偏好。曾切到平铺的用户不会看到“智能客服知识库升级”组，最关键的第一次闭环因此无法按文案复现。
- 具体修改建议：让主路径不依赖显示偏好，改为“在右侧 Workspace View 的未完成列表中找到刚创建的 Todo”。若必须按组定位，则在前面增加可观察且可执行的条件步骤：“若当前为平铺显示，点击‘分组显示’按钮切换后，在‘智能客服知识库升级’组中找到它。”

### P2 — 作用域示例再次把可选的分组状态写成必然结果

- 文件与行号：`docs/help/getting-started/scopes-and-views.md:27-33`
- 发现：示例第 2 点断言切到 Workspace View 后 Todo 位于 Project 分组，但 Workspace View 可以处于平铺显示。虽然“三处是同一条 Todo”的作用域结论正确，所给观察结果并非所有基线状态下都成立。
- 具体修改建议：第 2 点改为“切到 Workspace View 后仍能看到它；若当前采用分组显示，它位于‘智能客服知识库升级’组”。这样保留归属解释，又不把展示偏好误写成 View 语义。

### P2 — Archive 被收窄为“暂时不推进”，偏离正式领域定义

- 文件与行号：`docs/help/getting-started/projects.md:3,19-21,40`
- 发现：`CONTEXT.md` 将 Archive 定义为“让 Project 可逆地退出活跃工作范围”，并明确它本身不表达是否完成。文章多次把它限定为“暂时不推进”的选择，容易让用户误以为已经完成但仍需保留的 Project 不应 Archive，或者 Archive 隐含未来必定恢复。
- 具体修改建议：统一改为“当 Project 不再属于当前活跃工作范围、但仍要保留内容时使用 Archive”；继续保留“Archive 不表示完成”和“可恢复”。删除“暂时”与“之后重新投入”的必要性暗示，恢复步骤可写成条件路径。

## 最终复核项（不计缺陷）

以下目标均在 `docs/help/PLAN.md` 的计划内，但当前尚未生成；待其他组文章和入口页落盘后统一检查可达性与目标页标题，不在本轮判为缺陷：

- 四篇的“上一级”链接：`../README.md`。
- `10-minute-start.md:66` 与 `projects.md:59`：`../capture/quicknote.md`。
- `workspace.md:30,43`：`../trust-and-help/local-data.md`。
- `scopes-and-views.md:40,56`：`../momentum/todo-scope.md`。
