# 会话标题与导航收尾（2026-10-23）

## 工作包

- 关联 Issue：待主 agent 提供并关联。
- 基线：`codex/builtin-cli-compat`，接手 HEAD `22a89a0`；先保留已有七文件改动，再合入 `origin/develop@77afa4f`（含 PR #223 会话标题同步）。
- 需求依据：本轮用户明确要求首问标题预算、heading 新增按钮前的加载状态、无文字运行 spinner、Workspace / Project 导航密度与高亮一致；滚动规范见 [设计系统](../design-system.md#滚动区域与边缘遮罩默认规范)，发布分工遵循 [发布流程](../agents/publish-flow.md)。
- 交付：OpenAI 兼容首问标题保留完整输入、短标题/语言/超时策略，并为 reasoning 提供有界输出预算；加载及运行 spinner 可访问；记录、文件、会话导航排版与高亮统一，复用连续边缘遮罩及 reduced-motion。
- 非目标：模型/业务协议重构、HTML、其他 runtime 工作树、`codex/memory-system`；不启动 review 子 agent，不运行 UI/Tauri，不 push / 创建 PR / 远端合并。
- 验收：长中文首问及含 reasoning 的输出能生成标题；输入和输出预算边界仍生效，原 prompt 不变；加载 spinner 紧邻新增按钮之前，运行状态只有可访问图标；导航共享密度/颜色规则，既有遮罩与 reduced-motion 不回退。
- 验证范围：定向 Node 标题/共享模型用例、真实本地 provider 子进程标题集成、DSH check；定向 Vitest 会话/导航/滚动遮罩和上游标题同步回归。生产构建及双轴检查由主 agent 集中完成，不重复 Cargo 或整个前端测试。
- 修改前进程检查：已有本工作树 Vite（PID 43147）；未发现 Tauri dev。验证全部静默，无窗口启动。

## 实现与验证

待完成后记录命令、计数、提交范围与 UI 验收交接。
