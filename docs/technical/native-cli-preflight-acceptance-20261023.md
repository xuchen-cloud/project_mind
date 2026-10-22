# 原生 CLI 授权与写入判断验收（2026-10-23）

关联 Issue #217，基线 develop `32a9c40`。范围覆盖 Todo、Record、File。

## 交付

- 新增只读 `connection.status`，输出绑定身份、实时 grant 的 Workspace/Project 范围、native operations 与 objectKeys；不输出凭据或 lease token。
- 内置调用返回真实执行 lease 的 `executionMode`；外部调用返回 null，表示不提供内置执行模式信息。scope/operation/object 授权和来源可见性继续由业务调用复核。
- `mind doctor` 先 connect、再查询状态，返回 canonical workspacePath、connected 及上述快照；查询失败正常向上传播。CLI/MCP 使用同一注册契约，离线 help/schema 可发现。
- Skill 按 writing-for-agents 更新：先确定授权和用户所指对象，复用已读原生证据，需要时有界读取；根据意图选择 Todo 创建/更新/子任务、Record 新建/追加/纠正、File 新建/保持 ID 生成版本。相似文本和同名文件不直接决定身份，有限查询不声称全集无重复。
- 写入仍按对象保存 requestId、exact payload 和 receipt；批量暂缓的当前工程取舍与评估条件覆盖三类对象，Todo 内容过滤可扩展现有查询指纹。未增加这些接口或语义唯一约束。

## 验证

| 范围 | 命令 / 证据 | 结果 |
| --- | --- | --- |
| 红灯 | 新增状态请求到真实 socket → dispatch → 原生 grant/DB，过滤 `real_socket_uses_native_projects_and_live_grant_checks` | 旧实现返回不支持，0 通过、1 失败 |
| Bridge / CLI / MCP / lease | `cargo test --manifest-path src-tauri/Cargo.toml --target-dir /Users/xuchen/project_mind/src-tauri/target --config 'profile.test.package.project_mind_alpha.debug=0' --lib agent::bridge:: --quiet` | 107 通过，0 失败，5 个已有环境限定用例 ignored |
| 关键状态断言 | 上述套件 | 当前 grant 范围/权限、外部 mode=null、无 token、拒绝伪造参数、撤销/旧 generation 失效；doctor canonical 路径与错误传播；三种内置模式及全部注册写方法在只读时仍被拒绝 |
| Node 绑定与 Skill | `node --test packages/dsh-assistant/test/mind-cli.test.mjs packages/dsh-assistant/test/skills.test.mjs` | 22/22 通过 |
| 真实 pinned Node 运行时 | `node --test --test-name-pattern='Mind CLI lease rc.2 runtime' packages/dsh-assistant/test/runtime.integration.mjs` | 1/1 通过；模拟 Provider 驱动真实 bash/临时 lease，凭据不进入模型输入或事件。该用例的 CLI 是 fixture，不作为新 native 状态接口的端到端证据 |
| Native / CLI 构建 | `cargo build --manifest-path src-tauri/Cargo.toml --target-dir /Users/xuchen/project_mind/src-tauri/target --config 'profile.dev.package.project_mind_alpha.debug=0' --bin project_mind_alpha --bin mind --quiet` | 通过；从实际 fe83 工作区构建，现有独立标题/侧栏修改保留 |
| 真实前端与 Provider | 正常重启开发版，在独立验收会话设 Read Only，请求先加载 Skill 再使用注入绑定运行 doctor | Completed in 6s；展开实际 Bash 工具输出确认 `ok:true`、当前 Project 范围、完整 native operations、`executionMode:read-only` 和 canonical workspacePath。一次调用，无原生内容写入。验收后返回原会话，草稿“1”保留、原执行模式恢复 |
| 文档 | diff、14 个相对路径及锚点、行为分支核对 | 通过 |

## 主 Agent 自检

Standards：状态从当前已认证的 RequestContext 投射，lease 保存真实模式；不增加授权缓存、兜底或重试。业务鉴权、CAS、幂等和 receipt 原子提交保持。CLI 测试注入范围仅为现有 bridge 调用边界，生产仍使用实际 client/connect/call。

Spec：Todo/Record/File 均有授权核对、创建/继续修改分支、现有对象 CAS 和逐项恢复/结果报告。File 续改保留 ID，Record 按用户意图更新当前正文并由原生版本保留历史；未将文本相似强制变成合并或子任务。查询覆盖和并发去重的限制明确。

两轴由主 Agent 自检，未启动 review 子 Agent。已有通过验证在源码、依赖和环境不变时复用；未运行无关前端全量测试。
