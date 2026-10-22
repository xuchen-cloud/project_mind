# Mind CLI Todo 契约与 Skill 验收

- Issue：[#210](https://github.com/xuchen-cloud/project_mind/issues/210)
- 基线：develop `1bef716b475b09f68a5942abc1467f271a0488fa`
- 环境：macOS arm64，本地原生 SQLite / Bridge / mind CLI；2026-10-23，Asia/Shanghai。
- 范围：Todo 公开契约、结构化清单、CLI 发现/诊断、内置 Skill。没有修改前端组件；本包不重新声明 UI 自动刷新已验收。

## 原问题与交付

旧 CLI 实际复现：`todo create --help` 报 Missing option value；`todo.list` 不存在；默认 capabilities 为 59,352 字节。原 Todo schema 未公开优先级、完成状态和日期语义，空查询混用搜索预算错误。

交付如下：

- 原生 Todo 优先级、状态校验与 schema 使用共同值集。日期 schema 说明有效日历日期、必填 nullable 截止日以及历史 `progressDate` 的含义。
- `todo.list` 直接读取当前原生数据，不依赖全文索引。父任务和子任务按各自状态、截止日筛选；包含无截止日、子任务开关、页数及字符预算。
- 清单使用实际授权和对象归属，排除归档项目、撤回对象和禁用来源；Workspace scope 只包含 Workspace 所属对象。Workspace View 的跨项目集合仍须逐个查询获得授权的活动 Project。
- 分页游标绑定查询、连接/授权和原生变更序列；发生变更返回 SOURCE_CHANGED，重新查询后再声明覆盖完整。
- 子命令提供离线 help 和精确 schema 指针。capabilities 默认只有可调用方法摘要；doctor 默认只有连接和绑定；`--verbose` 保留详细目录。
- 依照 writing-for-agents 重写主 Skill，按 Todo、Record/File 分支加载参考指南。保留 CAS、幂等、回执和读回流程；补齐日期清单、创建、父子完成及子任务编辑实例。

非目标：QuickNote 写接口、Todo dry-run、通用搜索分页、界面改版。Skill 明确相关能力边界。

## 验证

以下 Rust 命令使用 `--manifest-path src-tauri/Cargo.toml`、共享 target 和 package debug=0；测试及构建保持静默，无应用窗口。

| 范围 / 命令尾部 | 结果 |
| --- | --- |
| `cargo test --lib agent::bridge:: --quiet` | 102 通过；5 个显式 ignored，其中新增 1 个临时接入 fixture 已单独执行 |
| `cargo test --lib agent_todo_list --quiet` | 4 通过：独立筛选、分页、授权/策略/归档、预算/截断 |
| `cargo test --lib agent::connection_todos:: --quiet` | 3 通过：枚举、日期语义、required nullable 截止日 |
| `cargo test --lib source_search_index:: --quiet` | 16 通过：查询约束、Unicode 边界、准确错误等 |
| `cargo test --lib db::agent_todo_outputs:: --quiet` | 10 通过：原生写入/CAS/幂等行为 |
| `cargo test --lib agent::todo_tools:: --quiet` | 2 通过：目标 DTO、仅 scope 的 schema/运行时默认值 |
| `node --test packages/dsh-assistant/test/skills.test.mjs scripts/stage-dsh-runtime.test.mjs` | 23 通过，含参考文件递归打包与 manifest 校验 |
| `cargo build --bin project_mind_alpha --bin mind --quiet` | 通过 |
| `git diff --check`、Skill 相对链接/锚点检查 | 通过 |

最后一项 schema 修正后重跑受影响的 todo_tools 测试和双二进制构建；其余已通过检查的实现、依赖与环境未变化，复用结果。未扩张到无关前端全量构建和测试。

最终二进制命令检查：

- `todo create --help`、`todo list --help`、`schema todo.list --json` 成功；37 个注册方法均有 help 回归覆盖。
- capabilities 默认 8,237 字节、37 个方法、不带参数 schema；verbose 64,672 字节并保留完整目录。
- doctor 对原生连接输出 176 字节，仅含 connected/binding。
- 空白及空字符串 source.search 均返回 INVALID_ARGUMENT，明确指出 query 应包含非空白字符。
- 最终 todo.list schema 的 required 仅包含 scope。

## 新 Agent 的公开资料使用测试

单独启动 `manual_cli_contract_fixture -- --ignored`：临时原生数据库、真实连接鉴权、Bridge transport 和生产 dispatch；不打开或写入用户 Workspace。以固定假测试凭据连接，退出后清理临时文件。

新 Agent 使用 gpt-6.1-sol，输入仅包含 Skill 路径、CLI 路径和临时绑定。允许读主 Skill、其引用指南及公开 help/schema；禁止读产品源码或直接访问数据库。测试进程不是 UI，也没有调用用户模型配置。

结果：11/11 指定步骤通过，另加 scope-only 默认值检查；误用 0、重试 0。

| 行为 | 观测 |
| --- | --- |
| 创建重要不紧急、无截止日父任务和明日截止子任务 | 实际 ObjectRef、子任务 ID、回执和读回均确认 |
| 完成父任务 | 父任务 finished，原子任务保持 unfinished |
| 追加无截止日子任务 | 新 ID、未完成状态及无截止日确认；其他字段保持 |
| 完成原子任务 | 保留内容、progressDate、dueDate、顺序和创建时间；原生 completedAt 更新 |
| 明日 / undated / status 清单 | 8 个筛选查询均完成所需分页 |
| limit=1 全量清单 | 3 页、3 条 action，无遗漏或重复 |
| 写入证明 | 4 次 mutation，4 次 operation.get 确认，6 次新鲜读回 |

测试发现 schema 将可省略过滤项误标为 required，Agent 当时按 schema 显式传 null，未产生失败调用。主 Agent 补上默认值标注与契约测试，最终二进制验证 required 仅为 scope；另通过原生调用确认仅传 scope 可用。

此测试证明临时 Project 的公开 CLI 旅程。并发变更、策略、越权、只读行为由上表自动回归覆盖；不把这次结果扩大为用户工作区、其他项目或前端 UI 验收。

## 主 Agent 双轴检查

- Standards：检查公开 DTO/实际校验一致、权限与实际归属、原生版本、只读无写入、过滤后分页、输出预算、游标失效、注册/CLI/MCP 分发和参考文件打包。发现的 optional schema 不一致已修复，无剩余发现。
- Spec：逐项核对 #210 的交付与非目标，覆盖创建/完成/子任务/日期清单、准确诊断和按需发现；确认 Skill 使用当前回执与版本，不猜 ID、版本或可用 API。无剩余发现。
- 未启动 review 子 Agent；上述新 Agent 只执行公开接口验收。
