# Issue #95 验收与主 agent review

## 已完成

- 视觉方案及独立参考资产先提交于 `ea51050`，随后实现两个首页。
- Workspace：项目导航、完整工作区标签、吸顶 QuickNote、紧凑 Record 卡片、工作区 Todo 与 Nori 品牌区。
- 普通 Project：最近打开的 5 条记录、完整项目标签、项目封面/图标、QuickNote 与 Record、可调上下分区的 Todo / File。
- 自动保存只写 QuickNote。整篇新建/追加通过数据库事务写 Record 后清空 QuickNote；失败保留草稿，重复点击合并，旧保存不会恢复已经发布的内容，追加校验目标项目与记录版本。
- 新建 Record 后使用既有 AI Metadata Fill；显式标签保留，首行标题优先规则交给 AI 结合全文判断，无 AI 时保留可用标题。开始编辑、进入 Focus 或切换 Workspace 后不应用过时的自动元信息。
- Focus 页面不改版；编辑卡片仍可通过明确入口进行，单击摘要进入 Focus。

## 静默验证

- 前端全量：合并 main 的发布与编辑器修复后，99 个文件、795 项测试通过。
- 最后涉及项目改名/发布协调、文件区导航控件的变更：28 项相关交互测试通过。
- Rust 全量：176 项通过、3 项既有忽略项。
- TypeScript + Vite build 通过。既有 vendor 大包提示仍在；主脚本 245 KiB，低于 250 KiB 门限。
- `check:ui-standards`、`check:portable-paths`、`check:bundle-boundaries`、`git diff --check` 通过。

## 界面验收

[当前源码的隔离预览](implementation-preview.html) 使用内存演示数据，调用实际首页组件，不会向真实 Workspace 数据库发命令。用 `npm run dev` 启动后访问 `/docs/design/homepage-visual-upgrade/implementation-preview.html`。刷新恢复演示记录；封面/图标选择保存在此浏览器自己的 IndexedDB 中。

已通过浏览器观察与操作验证：

- 1600×992 两类首页的三栏布局、紧凑封面、独立品牌图、卡片与工具栏。
- 全部标签（含未使用标签）、零结果、标签与搜索交集、一次清除全部过滤条件。
- QuickNote 展开/关闭和焦点恢复、发布清空、追加至现有记录并保留标题和原标签。
- 封面内置选择、图标选择与保存；900×700 右侧 Todo / File 抽屉打开和关闭。
- 文件区沿用原有完整文件组件；文件操作回归由组件测试覆盖。

原生应用的界面工具连续超时，因此没有把原生端到端交互记为通过。调试应用产物已生成；更新签名步骤因环境未提供私钥而未完成，这不是本次源码构建门禁。原生持久化/范围/事务由 Rust 测试覆盖；真实 AI 服务和系统文件选择器未在此次隔离预览中调用。

## Standards / Spec 自查

主 agent 完成两轴检查，没有启动 review 子 agent。检查范围为本次相对 `1c78fee` 的变更及 main 合并结果；唯一导入冲突保留首页组件和 main 的记录改名辅助函数，编辑器迟到保存修复完整保留；原有 22 个 develop 基线提交按 Issue 指定保留。

Standards：界面色值集中为 token；样式作用域限制在首页；使用现有编辑器、Todo、文件及元信息服务；数据库写入使用保存点；输入范围和过期结果均校验；不新增 Workspace File 实体。

Spec：统一首页、导航和标签范围、自动保存与发布语义、整篇追加、封面和项目图标、Nori、响应式抽屉及 Focus 不改版均已核对。审查中发现的筛选清除竞态、窄窗展开后立即折叠、已提交内容被迟到保存恢复、AI 结果覆盖用户编辑、发布后刷新失败误提示等问题已修复。无遗留阻断发现；原生工具限制如上记录。
