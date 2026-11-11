# WP07：依赖补丁与开发入口

## 范围与验收（2026-11-11）

- 基线：`ca8ecfc4806ac0c9ce3736a97bd9de556717ab71`。独立分支 `codex/wp07-security-dependencies`；工作包发现 `SEC-DEP-01`、`SEC-DEP-02`。
- 关联 Issue：只读核对 [#81](https://github.com/xuchen-cloud/project_mind/issues/81)（开发入口，已关闭）与 [#201](https://github.com/xuchen-cloud/project_mind/issues/201)（依赖清理，已关闭）。两者为历史相关范围，均不是此次安全修复工单；精确查询未找到 markdown-it/Vite 安全修复 Issue。不新建 Issue，不将集成 PR #316 当作 Issue。
- 依赖：无需其他 WP 代码；本包独占根 `package.json`、根 lock 和开发入口配置，其他包清单/lock 不变。
- 交付：Vite 和 markdown-it 使用涵盖已确认公告的最小受支持修复版；默认前端开发服务仅监听 loopback，LAN 必须显式启用。
- 非目标：全量依赖升级、系统安全设置、真实敏感文件读取、对外服务、GUI/Windows/多窗口验收、远端推送/合并/发布。此次用户限制优先于自动发布流程。
- 验收：锁文件版本不再受相关公告影响；实际解析的默认开发配置为 loopback；普通 Markdown 表格、链接、嵌套内容、粘贴/AI 入口语义保持；病理 reference 输入行为与时间预算回归通过。
- 验证范围：独立干净根依赖安装、针对性渲染/编辑器测试、开发配置检查、前端类型与 production build、Record/Source worker 构建及受影响构建工具测试。Vite 负责这些产物，故必须覆盖其真实构建。未变更 Rust/DTO，不运行全量 Rust。已有通过验证仅在输入不变时复用。

## 修复前证据

- 原 checkout 有用户未提交修改，保留原样；独立 worktree 从审查固定基线建立。进程检查未发现 Tauri/Vite 或 npm/pnpm/yarn install，未启动窗口。
- 基线根 lock：Vite `8.0.3`，markdown-it `14.3.2`；`npm run dev` 显式 `--host 0.0.0.0`。文件读取风险由官方公告和静态配置核对确认，未执行攻击请求。
- Node `26.8.1`，只读使用原 checkout 的 markdown-it `14.3.2`（不是 clean install 证据），与生产一致的 `commonmark`、`html:false`、`table` 配置：未闭合 reference title 的 50,009 / 100,009 / 200,009 / 400,009 字节输入分别 33.8 / 99.1 / 640.5 / 3219.9 ms。最后样本违反 1500 ms 纯解析预算并触发断言失败。这是单机纯逻辑样本，不是 GUI/p95。

## 官方版本依据

- [Vite 支持策略](https://vite.dev/releases)：8.1 仍接收安全补丁；8.0 已不受支持。
- [GHSA-p9ff-h696-f583](https://github.com/vitejs/vite/security/advisories/GHSA-p9ff-h696-f583)：8.0.5 仅修复原始 WebSocket 文件读取公告。
- [GHSA-rq7h-c2jc-7f22](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22)、[GHSA-9jrq-w75r-8gcw](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw)：8.1.6 修复后续文件服务/中间件问题。
- [GHSA-p4f5-76q4-ffq7](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7)（2026-11-10）：8.0.0–8.1.6 受影响，8.1.7 修复。故选择 `8.1.7`，锁住该版本，不升大版本，也不只停在 8.0.5。此新增公告只做版本覆盖核实，未动态执行其攻击载荷。
- [GHSA-gfr2-rv44-r23c](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-gfr2-rv44-r23c)：14.1.0–14.3.2 受影响，当前 14 分支修复版本为 `14.3.3`。

## 补充设计分析的适用性

已读取 2026-11-11 追加的原报告、工作包和 `07-codebase-design.md`。新增 CD-01～CD-06 分别约束其他工作包，没有新增本包缺陷或架构改造要求；分析明确 WP07 保持依赖与局部入口范围。本包沿用既有渲染 Interface，通过实际 `renderMarkdownToHtml` 验证第三方修复，没有再增加 parser/adapter/worker 框架。复用仍有效的安装、渲染和构建验证；audit 条目仅作扫描结果，不当作新增已证实产品漏洞计数。

## 实现与验证

### 交付行为

- 根清单固定 Vite `8.1.7`、markdown-it `14.3.3`，同步根 lock。锁文件版本变化均在这两项的依赖闭包内：Vite 必需的 Rolldown/bindings、PostCSS 等随之更新；其他直接依赖不升级，子包清单与 lock 无改动。
- `npm run dev` 使用配置中的 `127.0.0.1:1420`，保留 `strictPort`；裸 `vite` 和 Tauri 的 `beforeDevCommand` 同样采用此默认值。需要 LAN 时显式执行 `npm run dev:lan`（`--host 0.0.0.0`）；本轮没有运行 LAN 命令。
- 新增 `src/lib/richTextContent.security.test.ts`，直接调用生产 `renderMarkdownToHtml`，覆盖有效多行 reference、普通链接/代码/HTML 转义、列表内嵌套引用表格、围栏内容，以及未闭合 title/label 的字面输出与 2 秒预算。病理样本各约 360 KB，Node 环境只测同步转换，不伪称浏览器帧耗时。

### 验证台账

环境：macOS arm64、Node `26.8.1`。下列最终检查针对本包代码、根 lock 与独立安装，不借用原 checkout 的可写 node_modules。日志保留在与 worktree 同级的 `project-mind-wp07-security-evidence-20261111` 目录；构建产物在此 worktree 的 ignored 目录。

| 命令 / 范围 | 结果与证据边界 |
| --- | --- |
| `npm ci --no-audit --no-fund --registry=https://registry.npmjs.org` | 空 node_modules 的根 clean install 成功，665 个包；执行既有 postinstall DOM 修补。未更改用户 registry 或系统设置。 |
| `npm audit --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org --json` | 不再列出 Vite 或 markdown-it；全树仍有 11 项其他依赖告警，超出本包已确认范围。audit exit 1 为其余告警，不能称全树 audit 清零。 |
| `resolveConfig({}, 'serve')` 与显式 `server.host` 覆盖 | 实际加载根配置，默认 `127.0.0.1`、显式 LAN `0.0.0.0`、端口 1420、strictPort 和 Tauri 命令均符合；只解析配置，未启动服务器/监听器。 |
| 基线原始开发脚本断言 | 原 `--host 0.0.0.0` 触发预期失败。文件读取公告可达性为静态依据，未动态读取文件。 |
| 新增安全测试 + 临时 alias 到原 `14.3.2` 模块只读副本 | 4 项普通语义通过，title/label 两项预算分别约 3211/3150 ms，均失败。仅隔离替换该解析模块，不称基线全依赖 clean install。 |
| `vitest run src/lib/richTextContent.security.test.ts src/lib/richTextContent.test.ts --maxWorkers=1` | 固定依赖下 2 文件、19/19 通过，含两项病理输入；同输入规模纯解析微测 400,009 字节由约 3219.9 ms 降至 86.7 ms（单次逻辑样本，非 p95）。 |
| `vitest run src/components/rich-editor/RichEditor.test.tsx --maxWorkers=1 -t 'paste\|pastes\|streams markdown answers\|streamed Markdown\|AI edits'` | 所选 19/19 通过，其他 125 项未运行。覆盖粘贴和 AI Markdown 实际编辑器调用；不是 GUI 或真实 Provider 验收。 |
| `npm run build:record-worker`、`npm run build:source-worker` | Vite 8.1.7 实际构建均通过。 |
| `vitest run src/lib/record-document.node.test.ts src/lib/record-document-html.node.test.ts src/lib/source-text.node.test.ts src/lib/source-pdf.node.test.ts src/workers/record-document-worker.node.test.ts src/workers/source-extraction-worker.node.test.ts --maxWorkers=1` | 6 文件、48/48 通过。 |
| Office/Markdown 前端资源准备 | 每个使用的子包在本 worktree 按原 lock 独立安装，DOCX/PPTX/HTML2DOCX 实际构建、XLSX `node packages/office-xlsx/scripts/build.mjs --skip-native`、Markdown `verify:vendor` 通过。DOCX 519 个上游文件与 HTML2DOCX 31 个文件从已有本地源码逐项按 source-lock 校验后物化；未拷贝既有 dist 代替构建。未构建 XLSX Rust sidecar。 |
| `tsc --noEmit`、`vite build` | 均通过，真实宿主 production build 完成；保留既有大 chunk 提示。未执行完整 Tauri 安装包打包。 |
| `node --test scripts/office-renderer-resources.test.mjs` | 2/2 通过，真实 Vite 资源插件 development/production 行为；测试服务仅本地 loopback fixture。 |
| `node --test scripts/markdown-export-portability.test.mjs` | 2/2 通过。 |
| `node --test scripts/office-performance/host-bundle-boundary.test.mjs`、`npm run check:bundle-boundaries` | 6/6 通过，Office 编辑器保持 lazy；宿主入口满足 250 KiB 预算。 |
| `git diff --check` / lock 变化范围核对 | 通过；所有版本变化属于目标依赖闭包，其他子包 tracked 文件未变更。 |

开发中首次工具测试遇到缺少 Markdown 包局部 esbuild 和宿主 dist；准备对应依赖/构建后仅重跑失败两文件，已通过的 renderer-resource 两项复用。首次类型/宿主构建缺少 HTML2DOCX dist；其准备时远端 TLS 连接被重置，改用原有 `--source` 流程按 checksum 核验本地相同版本源码，再完成该包构建及失败的 tsc/Vite。未通过放宽检查或改版本解决环境缺件，也未重跑无关全量测试。

初始沙箱只读进程检查被 `operation not permitted: ps` 拒绝，创建本地分支时也因不能写原仓库 `.git/refs/heads/codex/wp07-security-dependencies.lock` 而未执行成功；经批准后相同目标已成功完成，没有不确定的半成品或自动风险审查拒绝。后来用户切换为完整访问并要求继续；此后操作仍限本地测试与提交。

### Standards 自查

主 agent 根据 `AGENTS.md`、`docs/agents/*` 与 code-review smell baseline 检查本包差异。依赖范围限定、输入预算回归有真实失败证据、配置只有显式 LAN 覆盖，无额外通用框架。没有剩余发现，未启动 review 子 agent。

### Spec 自查与交接

以审查 `06-fix-work-packages.md` 的 WP07 和两条 evidence_report 为规格：两项版本修复、loopback 默认、显式 LAN、正常 Markdown 与病理输入、干净安装和真实受影响构建均有证据。没有剩余发现。

- 集成时涉及公共文件：根 `package.json`、`package-lock.json`、`vite.config.ts`；无跨端 DTO、命令或事件变更。独立 worktree 基于审查基线，后续 develop 变化由集成负责人合并，不覆盖其他工作区。
- 未验证 Windows、多窗口、真实 LAN/Tauri GUI、真实敏感文件读取或生产发行；没有将这些场景报告为通过。没有远端写入、新建 Issue、推送、合并、部署或发布。
- 历史 Issue #81/#201 不因本包本地提交被重新打开或关闭；新安全修复 Issue 未发现，交由集成负责人决定跟踪方式。
