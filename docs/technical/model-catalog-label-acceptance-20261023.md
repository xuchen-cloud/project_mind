# 模型目录显示名凭据兼容验收（2026-10-23）

关联 Issue #214；实现基线 develop `84428f5`。生产改动仅为 `shared-model.mjs` 的公开 provider 显示名投射；原生代码只增加回归用例。

## 原因与修复

模型配置名称原样进入 provider `displayName`。若名称包含本配置或其他已配置 API key，`session/modelCatalog` 的成功 HTTP 响应仍携带凭据；原生 carrier 的输出保护正确拒绝此响应，但界面收到统一的“助手通信失败，请重新连接”，因此表现为模型菜单无法加载。

公开投射现在检查所有已配置 key，命中时将整个名称替换为“默认配置”或“配置 <id>”。普通 Unicode 名称不变，provider/model ID、实际凭据解析、模型选择和原生输出保护不变。存储的用户配置名称不被改写。

## 验证

| 范围 | 命令 / 操作 | 结果 |
| --- | --- | --- |
| 合成红灯 | `node --test packages/dsh-assistant/test/shared-model.test.mjs`，修复前 | 6 通过、7 失败，锁定本配置及跨配置凭据进入公开投射 |
| 真实 pinned runtime HTTP 红绿 | 临时脚本启动 embedded runtime，固定合成凭据作为名称，调用真实 `session/modelCatalog` | 修复前后均 HTTP 200 / result.ok；响应含凭据从 true 变 false，原生 guard 拒绝预测从 true 变 false；脚本已清理 |
| 公开投射及私有解析 | `node --test packages/dsh-assistant/test/shared-model.test.mjs` | 13/13 通过；含重复、跨配置、纯 key 名称和普通 Unicode 名称；实际凭据解析保持 |
| 已有运行时集成 | `node --test --test-name-pattern='embedded model catalog\|embedded runtime uses the piped' packages/dsh-assistant/test/runtime.integration.mjs` | 2/2 通过，覆盖模型目录、配置传递、会话隔离、历史和正常关闭 |
| 原生 carrier | `cargo test --manifest-path src-tauri/Cargo.toml --target-dir /Users/xuchen/project_mind/src-tauri/target --config 'profile.test.package.project_mind_alpha.debug=0' --lib native_carrier --quiet` | 3/3 通过；真实 pinned Node runtime 的 modelCatalog 经过原生 fetch 和敏感输出保护成功；原生用例执行时修复已经生效，未将其算作红灯证据 |
| 原有安全边界 | 同上 cargo 参数，过滤 `carrier_fences_routes_correlations_credentials_and_actual_agent_scope` | 1/1 通过，故意含凭据响应仍被拒绝 |
| 静默 native/CLI 构建 | `cargo build --manifest-path src-tauri/Cargo.toml --target-dir /Users/xuchen/project_mind/src-tauri/target --config 'profile.dev.package.project_mind_alpha.debug=0' --bin project_mind_alpha --bin mind --quiet` | 通过；当前用户工作区包含独立的标题/侧栏未提交修改，均保留 |
| 真实前端 | 正常重启开发版、解锁原工作区、返回原项目与会话，打开模型菜单 | 修复前稳定复现报错；修复后显示“默认配置 / 配置 1”及 deepseek-flash，无 modelCatalog 错误；草稿“1”保留且未发送 |

## 主 Agent 自检

- Standards：改动限定在现有公开投射边界；复用已校验的配置，未增加通用框架、重试或降级，也未修改原生安全检查。测试断言不输出密钥、配置 frame 或公开目录全文。
- Spec：本配置与跨配置名称中的凭据均不进入公开投射；正常名称、身份和实际鉴权保持；原生目录和真实前端恢复，原有拦截仍有效。
- 两轴检查均无剩余发现；未启动 review 子 Agent。

复用上述通过结果；合并过程若只有无关的 Markdown 布局变更，不重复运行本包测试。
