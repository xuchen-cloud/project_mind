# GenOffice Word 创建与 CLI File 契约

Issue：[#257](https://github.com/xuchen-cloud/project_mind/issues/257)。实现基线：develop `3b1c19ed1ecb6e49d481f7050235f419f56d7c53`；收口已整合 develop `79e75189f2fc2faeb06be9ad56f261eec55375d8`（Workspace 免密码打开）。

## 交付与边界

- Skill references 通过当前会话发现且启用的 filesystem registry 读取，继续检查路径、符号链接与停用状态；业务 File 仍使用原生固定版本来源读取。
- `mind file create --name NAME --source-file PATH` 与显式 createTarget staging 接通原生 File 创建，支持 Workspace/Project，最多 100 MiB，保留 requestId、回执、v1/hash 和原生 journal 恢复。
- `file_office_create` 调用锁定 GenOffice 的空白 DOCX、AI restricted HTML parser、文档 schema 与 serializer，直接创建真实 Word 材料；支持中文标题、正文、基本标记、五层列表与简单表格。拒绝图片、图表、CSS、脚本和不支持的结构，不静默丢内容。
- 原始 HTML 请求决定创建幂等；重试读取首次创建的原件和版本，不重复生成新 File。Project 会话不能指定其他 Project；只读模式不能创建。
- `file_office_inspect` 接受完整 SourceRef 或路径（二选一）；文档说明 Project/Workspace 的路径基准。
- `file download --input-file READ.json --out NEW_PATH` 读取授权的固定版本字节，验证 hash/长度后原子写出，禁止覆盖，stdout 不携带 base64。
- file/record/todo list 支持共同 scope/limit/cursor/query 简写，保留 JSON DTO；帮助和诊断区分离线 discovery、在线 doctor。
- Office 文本抽取仍未支持，明确返回 unsupported_format、retryable:false、Office inspect 提示；内容搜索继续报告覆盖不足。

非目标：独立 GenOffice 聊天/账户、复杂 DOCX 样式与媒体生成、完整 XLSX/PPT 生成编排、Office 全文索引、File 删除权限和主动变更订阅。现有 Office 编辑链路保留。

## 验证计划

测试边界为公开工具、CLI/native File、格式引擎和受限 worker；使用隔离临时 Workspace，不写用户数据，不启动应用窗口。

- references：真实 registry、链接打包、停用/删除撤销、符号链接逃逸与业务 File 路由。
- GenOffice：真实 DOCX ZIP、中文/粗体/列表/表格、inspect、编辑往返、自包含 engine 重定位和 worker schema/预算。
- native：创建、字节一致性、请求重放/变更冲突、越权、stage 到期恢复、SIGKILL 五阶段恢复、失败无可见半成品。
- 实际 worker 与原生 File：创建 v1、固定版本读回、同 File 编辑为 v2、陈旧 CAS 拒绝与创建重放。
- DSH：实际 provider/registry/Session transport 和只读限制；原生内核/格式测试独立执行，不把 mock transport 当端到端证明。
- 收口：受影响 Rust 测试、DSH Node/transport、格式/worker、CLI 二进制和静态资源检查，主 agent 自行 Standards/Spec 检查。

## 验证结果

以下结果对应本工作包完整改动；构建使用共享 Cargo 缓存与固定 Node 24，未启动应用窗口。环境准备只涉及忽略目录内的依赖与签名资源，不改变产品校验。

| 范围 | 结果 |
| --- | --- |
| GenOffice DOCX build 与全部格式测试 | 构建成功，28 项通过，包括真实 ZIP、中文标题/列表/表格与编辑往返 |
| Office worker | 11 项通过 |
| DSH 普通 Node 测试 | 168 项通过；最初两项受依赖软链接 realpath 影响，使用本工作树独立依赖后补跑通过 |
| 最终 Office/source 工具检查 | 18 项通过 |
| DSH 全套 integration | 59 项通过；其中真实 CLI 项补齐默认构建路径后单独补跑通过 |
| 打包与资源检查 | 31 项通过，desktop check 和本地 Office distribution 构建成功 |
| Rust bridge | 129 项通过，6 项显式忽略用例另按所需范围执行 |
| Rust File version / Office / directory | 分别 50 / 15 / 57 项通过 |
| Rust importer / source / worker / DSH Office | 分别 17 / 13 / 5 / 10 项通过 |
| 真实 GenOffice → 原生 File | 显式运行通过：v1 创建与固定版本读回、同 File 保存 v2、陈旧 CAS 拒绝、创建重放仍返回原始 v1 |
| 真实 CLI → 原生 File | 显式运行通过：中文二进制创建、请求重放、下载 hash/长度与字节一致 |
| 五阶段进程崩溃恢复 | 新二进制创建 SIGKILL 用例通过；修正测试 hook 的信号/exit 竞争后，既有 Office 崩溃回归也通过 |
| 静态检查 | diff whitespace 通过；本次 Markdown 路径检查无违规 |

全仓 portable-path 检查仍受已有历史文档绝对路径影响（既有 Issue #187）；本次改动文档无新增违规。未做交互界面或排版截图验收；真实 DOCX 内容通过格式引擎和原生保存读回验证，既有编辑界面未修改。此结果不声称新增 Office 全文索引或复杂排版能力。

## 主 agent 双轴自查

- Standards：检查原生授权、Workspace/Project 归属、固定版本读取、stage 目标绑定、不可覆盖的原子下载、稳定调用方回执、目录导入 journal、Skill registry 撤销和符号链接约束；复用既有服务，无另建 File 身份或目录暗规则。新增 DOM 依赖精确锁版并生成许可证清单。无剩余发现。
- Spec：逐项对照 #257 的二进制创建、GenOffice Word 生成、同 File 续改、只读/跨 Project 拒绝、失败无半成品、重试幂等、references、list 简写、二进制读回、抽取状态与 Skill 契约；真实格式、原生存储和 DSH 工具分层验证。边界仍为基本 DOCX 生成，复杂媒体、XLSX/PPTX 生成编排和全文索引不在本包。无剩余发现。
- 未启动 review 子 agent；由主 agent 自行检查。


## 验证复现与基线整合

主要命令（在完整固定依赖及应用资源准备后执行）：

```sh
node --test packages/office-docx/test/*.test.mjs
node --test packages/agent-host/test/office-worker.test.mjs
node --test packages/dsh-assistant/test/*.test.mjs
node --test packages/dsh-assistant/test/*.integration.mjs
node --test scripts/stage-dsh-runtime.test.mjs scripts/office-distribution.test.mjs
node packages/dsh-assistant/scripts/desktop.mjs check
cargo test --manifest-path src-tauri/Cargo.toml --lib agent::bridge::
cargo test --manifest-path src-tauri/Cargo.toml --lib file_version_service::
cargo test --manifest-path src-tauri/Cargo.toml --lib db::file_imports::
cargo test --manifest-path src-tauri/Cargo.toml --lib dsh_assistant::office::tests::
cargo test --manifest-path src-tauri/Cargo.toml --lib office_creation_real_genoffice_saves_reads_and_edits_same_native_file -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml --lib actual_cli_creates_chinese_binary_replays_identity_and_downloads_exact_bytes -- --ignored
cargo build --manifest-path src-tauri/Cargo.toml --bin mind --bin project_mind_alpha --quiet
```

Node 使用 agent-host 固定运行时；真实 CLI 用例要求先构建 `mind`，若使用外部 Cargo 缓存目录则通过 `PROJECT_MIND_TEST_CLI` 指定实际可执行文件，DSH 现有集成测试还要求默认 `target/debug/mind` 路径可用。

整合 `79e75189` 时仅 `dsh_assistant.rs` 和 `lib.rs` 与本包有文件交集，自动合并后逐段核查，保留 Workspace 新语义。整合后重新构建两个原生二进制，并补跑 DSH Office 10 项、GenOffice 原生端到端 1 项、importer 17 项、bridge 129 项和 Workspace 无密码 5 项，全部通过；未变动的格式、DSH 和打包验证复用既有结果。
