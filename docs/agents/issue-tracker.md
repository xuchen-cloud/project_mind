# 议题跟踪器：GitHub

本仓库的议题和 PRD 存放在 GitHub Issues 中。所有操作使用 `gh` CLI。

## 约定

- **创建议题**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取议题**：`gh issue view <number> --comments`，使用 `jq` 筛选评论，并同时获取标签。
- **列出议题**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，并根据需要使用 `--label` 和 `--state` 过滤。
- **评论议题**：`gh issue comment <number> --body "..."`
- **添加或移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭议题**：`gh issue close <number> --comment "..."`

根据 `git remote -v` 推断仓库；在克隆的仓库目录中运行时，`gh` 会自动完成推断。

## 将 Pull Request 作为分诊入口

**PRs as a request surface: no.** _（如果本仓库将外部 PR 视为功能请求，可改为 `yes`；`/triage` 会读取此标志。）_

设置为 `yes` 后，PR 将与议题共用相同的标签和状态，并使用对应的 `gh pr` 命令：

- **读取 PR**：`gh pr view <number> --comments`；使用 `gh pr diff <number>` 查看差异。
- **列出需要分诊的外部 PR**：运行 `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，仅保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的项目，排除 `OWNER`、`MEMBER` 和 `COLLABORATOR`。
- **评论、添加标签或关闭**：使用 `gh pr comment`、`gh pr edit --add-label` / `--remove-label` 和 `gh pr close`。

GitHub 的议题和 PR 共用同一个编号空间，因此裸编号 `#42` 可能代表任意一种对象。先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## 当技能要求“发布到议题跟踪器”

创建一个 GitHub issue。

## 当技能要求“获取相关工单”

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图（map）**是一个独立议题，**子议题（child）**是地图中的工单。

- **地图**：带有 `wayfinder:map` 标签的单个议题，其正文包含 Notes、Decisions-so-far 和 Fog。使用 `gh issue create --label wayfinder:map` 创建。
- **子工单**：通过 GitHub sub-issues API（使用 `gh api`）链接到地图的议题。如果仓库未启用 sub-issues，则把子工单加入地图正文的任务列表，并在子工单正文顶部添加 `Part of #<map>`。标签使用 `wayfinder:<type>`，其中类型为 `research`、`prototype`、`grilling` 或 `task`。工单被认领后，将其分配给负责推进的开发者。
- **阻塞关系**：优先使用 GitHub 原生 issue dependencies，作为标准且在界面中可见的表达。添加依赖边时运行 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞议题的数字数据库 ID（通过 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取），不是 `#number` 或 `node_id`。GitHub 通过 `issue_dependencies_summary.blocked_by` 报告仍处于开放状态的阻塞项。如果依赖功能不可用，则在子工单正文顶部添加 `Blocked by: #<n>, #<n>`。当所有阻塞议题都关闭后，该工单即解除阻塞。
- **前沿查询**：列出地图中所有开放的子工单（使用 `gh issue list --state open`，并限定在地图的 sub-issues 或任务列表范围内）；排除存在开放阻塞项（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中仍有开放议题）或已有负责人（assignee）的工单；按地图顺序选择第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`。这是会话中的第一次写操作。
- **解决**：先运行 `gh issue comment <n> --body "<answer>"`，再运行 `gh issue close <n>`，最后把上下文指针（gist 和链接）追加到地图的 Decisions-so-far。
