# G：Office 准入、字节读取与回执

关联 #118/#191；扩展审计 E01/E02/E03。基线 `5de9a91`，主 agent 实现和验收；不启动应用、不单独提交。

## 范围与验收

- 回执只持久化固定版本、hash 和 stage 身份，不再复制完整 renderer model/base64。重复保存仍返回原始 commit receipt；显示模型从该 receipt 指向的不可变版本恢复，不从后来推进的 head 恢复。
- 两个源读取准入槽覆盖 Office inspect/save/recalculate 的基线读取，直接 utility 请求也在 decode、再编码和 JSON/frame 分配前取得 worker 槽。候选和每个固定源保留原有 100 MiB 限制。
- DB/Workspace 锁内只做授权和生成原生读取计划；读文件、hash、base64 在锁外。完成异步运算后复核授权/归属/代次和固定版本。Unix 使用既有物理身份/ctime 证明，Windows 保留必要的内容 rehash。
- DSH 生成 SourceRef 时复核已验证版本的元数据，不在共享锁中再次读取并编码整个文件。CLI/MCP `file.bytes.read` 复用同一锁外读服务和准入。
- 旧 candidate 回执做一次事务迁移，只删除 `model` 字段，保留 payload hash、stage 与提交身份。不做全库 VACUUM。

非目标：不改变源授权、File/Version CAS、commit receipt、不可变历史、stage 崩溃恢复；不以旧 renderer model 作为权威数据。E05 的跨请求重算复用另行实施。

## 已执行证据

1. 修改持久化行为前，真实 SQLite `office_save_replays_same_receipt_and_rejects_reusing_id_for_different_edits` 新断言失败：candidate 回执确有完整 `model`。随后实现紧凑回执和固定版本恢复。
2. `cargo test --manifest-path src-tauri/Cargo.toml --lib file_office::tests --quiet`：16 passed，3 个环境/子进程辅助项 ignored。覆盖原有保存、授权、外部改写、固定历史和崩溃恢复；新增 20 个并发 inspect 的 worker 峰值不超过 2，worker 运行时可取得共享 DB 锁。
3. 上述测试通过后，又接入 DSH SourceRef 和 bridge byte read 路径，并增加 head 推进后回放原 receipt 的回归；这些增量需在最终 Rust 验证中覆盖，不能复用第 2 项作为全部最终源码通过证明。
4. `NODE_USE_ENV_PROXY=1 npm run build:office`：完整固定源构建通过，重新编译 XLSX sidecar；此前旧二进制缺少 `value` 字段的问题解除。初次直连源站失败后使用已有代理配置成功，没有降低 TLS 或源校验。
5. `npm run stage:office-runtime -- darwin-arm64`：资源校验与 staging 通过。
6. `node --test --test-name-pattern='identical XLSX bytes|saving typed edits|blank, numeric text|loadRange|range|recalculate|formula' tests/engine.test.mjs`（office-xlsx）：5/5，通过真实格式、跨表依赖、类型区分、公式错误与范围预算。
7. `src-tauri/resources/agent-host/node --test packages/agent-host/test/office-worker.test.mjs`：13/13，使用固定 Node 24.21.0；包含 relocation 后的真实 DOCX/XLSX/PPTX authoring。

迁移、最终变更及打包三格式 Rust 验收结果在主执行记录中集中补齐。
