# GenOffice 完整 Office 内容生成接入

关联 [#260](https://github.com/xuchen-cloud/project_mind/issues/260)，承接 #257。基线 develop `4f2ad6593377c20b237f777e1b66d1b05a897dbd`。

## 交付与依赖

以项目锁定的 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946` 为来源，核对其真实 `skills/genoffice/SKILL.md` 与 CLI/格式管线。复用 Word headless ops、Excel gateway 和 PPT pipelines/ops，接入当前助手，而非新增独立聊天、账户或任意脚本/路径权限。

- Word：兼容现有 restricted HTML；新增 HTML + 上游结构/格式操作，实现页面、样式、表格、页眉页脚、图表、内嵌图片等可保存能力，以及同 File 的操作续改。
- Excel：创建保留公式、格式和对象的多工作表，复用完整 gateway 操作和实际侧车重算；保持既有同 File 编辑。
- PPT：创建多页可编辑原生内容，复用上游页面 spec、布局构建、审计和原生 ops，支持图片、表格、图表等。
- 原生 File：三格式共用创建、归属授权、稳定回执、幂等和固定版本验收；不依赖目录发现。
- Skill：提供实际能调用的协议、来源、分阶段设计/生成/验收配方；不直接注入依赖独立 GenOffice 安装的未接入命令。

非目标：移植独立账户/聊天、开放任意磁盘或网络能力、声称覆盖上游不存在的格式语义。具体上游限制须明确返回；不能静默丢内容或退化为整页图片。

## 验收与验证范围

先以格式/worker/工具参数边界测试记录失败，再实现并跑受影响回归。分别验证格式引擎、真实 DSH provider/Session 工具运输和原生 File，不能以 mock 保存回执代替端到端。

实际产物须包含：复杂 Word 页面/样式/表格/图片；Excel 多表公式计算、格式、表格/图表；PPT 多页布局、可编辑文本和对象、图片/图表。生成后读回固定版本并编辑为 v2，验证同身份、旧基线拒绝、重复请求不重复建、只读/跨项目拒绝、失败无半成品。复杂排版使用隔离 headless 渲染检查；不启动用户应用窗口。

收口集中执行受影响格式测试、worker/DSH 测试、原生保存与静默编译、资源封闭性/源锁/许可证检查。主 agent 自行 Standards/Spec review；不启动 review 子 agent。

## 实现结果（2026-10-26）

三格式均使用同一 `file_office_create`，按安全文件名扩展名选择引擎；DOCX 兼容 HTML 字符串并接受 `{html,ops}`，XLSX 接受 `{sheets,changes}`，PPTX 接受 `{pages,operations}`。创建与续改均返回原生 File 身份、固定版本、hash 和回执；不依赖目录 watcher。创建内容及编辑 JSON 在工具边界限制为 2 MiB，原生反向 RPC 容纳内容与封装；创建计算也放在短提交锁之外。Office 编辑补齐只读 Session 校验。

- Word 复用固定版 headless 编辑器、真实操作目录和完整保存 side state。复杂样例包含中文标题/字体、页面、样式、合并表格、图片、原生图表及内嵌工作簿、页眉页脚/页码。DOM 及图片入口单独适配，禁用外部资源和可选原生模块；最终引擎重定位后仍可运行，分发检查保留且通过。
- Excel 从原生空白工作簿复用完整 gateway 保存，支持多表、公式、样式、行列/冻结/合并、表格、图表、图片、规则及已有 gateway 对象能力。原生重算保留数值/文本/布尔/错误的真实缓存类型；未实现函数保留公式、清除无效缓存并返回结构化 warning。无缓存公式的导入问题在私有计算副本修复，不发布临时值。
- PPT 复用 DeckSpec 和全部 72 个固定版原生操作，支持可编辑多页内容和插入对象别名，检查非法或会被截断的输入。新增图表内嵌 XLSX 以支持 PowerPoint 编辑数据，后续原生操作及编辑器保存同步适配器创建的图表数据；导入的外部工作簿保留。inspect 提供真实操作目标与上游布局审计。
- 内置 `genoffice-authoring` Skill 分格式渐进读取，整合原版 Skill、设计指南、原生操作组及精确 schema/catalog。保留 Apache 许可、来源提交及资源 hash；独立安装路径示例明确适配。同步脚本从实际引擎导出 7 个派生引用，并检查上游引用完整性。真实 Skill registry 已验证资源可发现、可读取。

“完整”限定为锁定引擎实际支持的可保存模型；不承诺覆盖微软 Office 所有特性。未实现的公式、渲染字体差异和启发式布局审计在格式合同中明确说明。

## 验证证据

以下为本工作树实现及其最终受影响范围的验证，未把 mock 回执作为原生保存证据。命令使用项目固定 Node；Rust 测试使用共享构建缓存并关闭包调试信息，不启动应用窗口。

| 范围 | 命令或用例 | 结果 |
| --- | --- | --- |
| Word | 包内 `node --test test/*.test.mjs`；后续严格验证/最终构建闭包回归 | 全包 32 通过；受影响 7 通过；最终闭包 3 通过 |
| Excel | engine/parity/create/真实 renderer 创建与续改；类型及源锁检查 | 25 通过；类型与源锁通过 |
| PPT | 包内 `npm test`，`npm run check`、`npm run sources:verify` | 21 通过；类型与源锁通过 |
| 实际排版 | Chromium Word 复杂样例，Excel 创建→显示→编辑→保存→重开，PPT 3 页渲染 | 产物和截图检查通过，PPT audit 无发现 |
| worker 与工具 | `node --test packages/agent-host/test/office-worker.test.mjs packages/dsh-assistant/test/office-service.test.mjs` | 25 通过 |
| DSH 单元 | DSH Node 测试集合 | 169 通过 |
| DSH 实际运输 | 完整 integration；最终 Office/权限受影响回归 | 67 通过；最终 36 通过 |
| 分发 | `office-distribution`、`stage-dsh-runtime` 测试；实际分发和 native staging | 31 通过；实际构建/打包通过 |
| 生产 worker 文件权限 | 实际 Excel gateway 保存测试 | 1 通过 |
| 原生 File 六组合 | `full_office_creation_real_engines_keep_identity_and_versions_for_project_and_workspace`，显式运行 ignored 用例 | 3 格式 × Project/Workspace 全通过；创建 v1、inspect、同身份 v2、旧 CAS 拒绝、原请求回放 v1 |
| 原生回归 | bridge/importer/worker/file_office/stdio 分类 | 129/17/5/15/2 通过；环境型 ignored 用例另记，不计通过 |
| 原生 DSH Office | `dsh_office` 测试组 | 11 通过、2 ignored |
| 静默编译 | desktop TypeScript/资源检查，Rust app 与 mind 二进制构建，最终根 TypeScript + Vite 生产构建 | 全部通过 |
| 桌面文件组件回归 | Office 编辑/预览、版本切换、隐藏 Tab 保存及 Project 内容组件，共 8 文件 | 194 通过；首次缺少未改动 HTML 转 DOCX 包构建产物，补齐后受影响 3 文件 111 通过，复用其余 5 文件 83 通过 |
| Skill | 实际 registry、builtin discovery、生成引用 `--check`、skill-creator validator | 资源读取/发现及合同校验通过 |
| 隔离验收准备 | 只读原工作区快照复制模型配置的 test-only fixture | 2 通过、1 opt-in ignored；显式初始化成功 |

`git diff --check` 通过；本包 25 个新增/修改 Markdown 的可移植路径检查无违规。全仓同项检查仍报告已有历史文档及固定 vendor README 的绝对路径，本包未修改这些文件，未放宽规则或批量改写上游。最终格式源锁分别核验 Word 519、PPT 515 个 GenOffice 文件及 PPT 4 个既有 Web adaptation 文件，Excel 源码和本地 patch 清单一致。

## 真实项目助手验收限制与用户授权

用户要求最后向真实项目助手发送相对模糊的任务，完成后询问其过程困难，再据反馈判断改进。已准备独立工作区、经营简报及真实模型配置；源工作区只读打开并通过原生接口重新加密复制配置，没有更改原工作区。

计划任务：“这个项目明天要给管理层做阶段汇报。帮我把 Word、Excel 和 PPT 都准备好，内容沿用项目里的资料，做得正式一些，数据和图表互相对得上。细节你来定，做好后自己检查一下。”计划随后单独询问工具、参数、文档、权限、保存或校验的实际困难及重试/绕路情况。

实际电脑操作接口返回 Mac 已锁定且无法自动解锁，拒绝取得应用窗口，也未提供登录密码输入接口。没有发送上述任务，因此没有助手完成记录或反思反馈，不能据此声称真实用户流程已验证。用户随后明确授权“如果不能验证直接提交代码到 develop”，据此在工程验证和双轴自审通过后发布；这项产品交互验收保留为未执行限制。没有将密码写入代码、验收文档或版本控制。

## Standards / Spec 主 agent 自审

Standards：核对单上下文领域用语、原生授权/归属和短提交事务、稳定请求与 payload 回执、固定版本 CAS、只读模式、资源预算、worker 数据边界、独立引擎封闭分发、锁定来源与第三方许可、Skill 引用可读性及可移植路径。未引入另一个 GenOffice 账户/聊天或任意脚本执行入口。无剩余阻塞发现。

Spec：按 #260 对照三格式复杂创建与同身份续改，检查可编辑对象和公式/图表真实字节、样式与结构读回、Project/Workspace 六组合、幂等/旧基线/越权/失败无半成品，以及实际助手工具注册和 Skill discovery。工程验收通过；真实项目助手模糊指令及反思反馈受锁屏阻塞，已获用户明确授权跳过后合并，不将其算作通过。无剩余代码发现。
