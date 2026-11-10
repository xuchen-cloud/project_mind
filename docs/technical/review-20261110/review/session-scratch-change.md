# AI 会话 scratch 文件策略

## 范围、依赖与验收

- 关联：2026-11-10 用户直接授权，未提供 Issue 编号；本包不创建或发布 Issue。
- 依赖：embedded DSH runtime 的实际 `systemPrompt` section、当前 Session header 的 cwd/id、既有隐藏目录扫描规则。
- 交付：AI 中间脚本、临时测试文件与数据写入会话工作目录的 `.mind-tmp/<session-id>/`；正常项目目录用于用户要求的最终交付物及明确要求保留的文件。
- 范围：提示词接线及现有 prompt/contract 测试，本记录。非目标：UI/目录树、session start/list/cache、自动清理/搬移/删除、全局工具 cwd、GUI/native build/full suite、commit/push、子 agent。
- 验收：Project/Workspace、新会话和已有会话后续轮次均在真实 prompt assembly 获得各自 scratch 路径；不使用受保护 `.project-mind`；路径按会话隔离；业务目录扫描与树排除 scratch；保留相对路径语义及原有 CLI 行为。
- 验证：有限 Node prompt/CLI 测试、原生扫描/树规则静态核查及 diff 检查。源码修改前已检查无运行中的 `tauri dev` / Vite；不启动应用。

## 实际链路与选择

- `packages/dsh-assistant/scripts/runtime.mjs` 在 embedded boot 中调用 `installMindCli`，传入当前 `mindContexts.forAgent/forSession`，随后绑定 Project/Workspace scopes，再公开 READY。这里是主应用真实会话入口；未修改旧 provider prompt 或仅供说明的文档。
- `scripts/mind-cli.mjs` 在原有 native CLI section 旁注册英文 `mind:session-files`，沿用 `DEPLOYMENT_PERSONA_SUFFIX` 顺序。注册不依赖某个 scope 是否有 CLI binding；已有 CLI section 和 shell executor 保持原行为。
- 安装的 DSH `dsh-agent-loop/lib/index.js` 的 `preStep` 每次调用 `systemPrompt.assemble(assembleContextFor(this, signal))`；`dsh-system-prompt` 每次 assembly 都求值 section 的 text 回调。`mindContexts.forAgent` 按实际 `session.header.cwd` 解析当前 scope；回调使用其 directory 和 `session.id`，因此已有/恢复会话的下一步及新会话都会获得规则，无需改 session create/list/cache 或重写历史。运行中的旧 host 需要正常重新加载更新后的 runtime；本包不重启用户应用。
- 未发现现成业务 scratch 约定，选择 `<session-workdir>/.mind-tmp/<session-id>/`，与应用保护目录 `.project-mind` 分离。提示词要求按权限按需创建、显式使用 scratch 路径、保留任务 cwd 的相对路径语义；仅用户要求的最终交付物或明确要求保留的文件可放入正常目录。没有自动建目录、清理、搬移、删除或伪造交付物。
- `interpolate: false` 与 JSON 字符串路径保证包含空格及 `${...}` 的目录原样到达 prompt；该路径是给 agent 的路径数据，不作为直接可执行的 shell 片段。

## 原生隐藏路径核查（只读）

- `src-tauri/src/db/project_directory_files.rs` 的 `excluded_component` 已排除所有 `.` 开头的组件；扫描循环在递归/注册前跳过这些项。因此 `.mind-tmp` 及其 Session 子目录不会纳入业务 File 扫描。
- `src-tauri/src/project_directory.rs` 的 `list` 复用同一规则排除隐藏目录，`resolve` 对每个路径组件复核；`excluded_project_path` 同时检查隐藏祖先。树枚举及直接下钻/预览均不能将 scratch 后代作为业务文件访问。Project 与 Workspace 共用这些路径规则。
- 已有 `hidden_directory_ancestors_block_listing_preview_and_resolve`、`hidden_register_and_import_reject_dot_files_and_hidden_directory_descendants` 等原生用例覆盖一般隐藏目录/后代约束；本包按用户限制不运行 Rust/native 验证。未发现需要精确补排除的缺口，因此未改树文件，也没有与 Mill 的文件重叠。

## 最终 diff 与检查结果

- 基线：`fe9fe9c188f05c23bae369074446e38c0859a0c8`，工作区同时存在其他 agent 的未提交改动；本包仅修改 `scripts/mind-cli.mjs`、`test/mind-cli.test.mjs`（均位于 `packages/dsh-assistant/`）及本记录。
- `node --test packages/dsh-assistant/test/mind-cli.test.mjs`：20 passed、0 failed、0 skipped。新增测试使用安装版本的真实 `SystemPrompt`、`assembleContextFor` 和 `renderPrompt`，验证已有/新建/重新载入 Session、跨 Project/Workspace 的独立路径、每步重组装、字面路径保真、无 CLI binding scope 的规则，以及原 CLI section 共存。prompt assembly 不执行工具、不发 bridge 请求、不查询 Session 列表。
- 既有 shell 测试补充调用方 workdir 保留断言；原有租约、权限、取消及并发 scope 测试全部通过。后续仅更新本记录，复用上述验证结果。
- 主 agent Standards 自查：英文正向、单一策略来源、按既有 section 生命周期注册，无全局 cwd 或 session caching 修改，无新框架/依赖/自动文件操作。Spec 自查：中间文件隐藏、最终交付/显式保留例外、实际新旧会话接入和原生排除均具备对应实现或静态证据。
- `git diff --check -- packages/dsh-assistant/scripts/mind-cli.mjs packages/dsh-assistant/test/mind-cli.test.mjs .full-review/session-scratch-change.md`：通过（exit 0）；本记录为新增文件，另已人工检查内容和 Markdown 格式。
- 限制：这是模型指令策略而非写入拦截器；未通过 GUI、真实模型执行或 native build 实测。按用户范围不运行全量测试、不提交/推送、不派子 agent，不修改 Pasteur 的 session 性能范围。
