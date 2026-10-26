# G1：DSH Client 与 Session 空闲驻留预算

用户在包 B 完成后追加授权；关联首轮性能审计 DSH Client/Session 常驻问题。独占范围：`packages/dsh-ui/adapters/index.jsx`（client map/release）、`packages/dsh-ui/adapters/client.jsx`（residentSessions）及对应测试。主 agent 处理原生 process 退出，本包不启动 review 或其他 agent，不提交/推送，不修改主执行记录。

## 交付与验收

- scope client 最多缓存 3 个空闲实例；每 client 最多缓存 4 个空闲 Session；空闲满 5 分钟释放，按实际最近使用顺序淘汰。
- 挂载 UI、未完成请求、活动业务 stream、running/首 turn 等待、pending submission、pending interaction、运行时输入/附件均保护；被动 catalog/follow 订阅可随安全空闲实例释放。
- 重新进入从权威 catalog/history 恢复；持久化草稿必须能恢复，不能丢失未持久化状态。
- 真实边界：React Host create/dispose 计数；真实 Cordis/Session 图 + fixture carrier 的 retained binding/follow 计数。先失败回归再修复，只运行对应测试。

状态：实现及指定范围验证完成（33/33）。首条回归先验证超过 3 个空闲 client 后按 LRU 释放及重入重建失败，再实现预算。

## 已交付与计数

- `index.jsx`：最后 UI seat 释放后进入空闲候选，最多 3 个 idle client；按 acquire/release 的实际顺序 LRU。超额立即回收，5 分钟 TTL 到期也回收；挂载 seat、初始化尚未完成及 `isIdle()` 为 false 的图不回收。淘汰前移出 map 并取消根订阅，旧 generation 不再转发事件；Workspace teardown 等待在途图 disposal。
- `client.jsx`：最多 4 个 idle `projectContent` Session 引用；select/release 更新 LRU，TTL 同为 5 分钟。由真实 retained source、Session snapshot、uiSession pendingInteraction、input state 和 RPC/stream 路径判定保护。busy、awaiting first turn、local submission、history loading、mainView/gateway 等外部引用、业务 stream、未落盘草稿、附件、reference occurrences、claimed/submitting/adjudicating 和 queue 均保留。
- 在现有 Connection RPC 和上传 fetch 边界统计开始/结算；不修改协议、原生 process 或 transport 文件。`$events`/`session/control`/`workspace/follow`/`session/follow` 是可随 idle 图释放的被动观察通道，正在进行的 Assistant attempt 另外跟踪；未结算 transient rows 亦保护，stream generation token 防止旧流结束清掉新流状态。
- 只有 localStorage 中存在完全相同的 draft 文本时才允许卸载非空文本输入；storage 失败、附件和 reference chip 继续保护。原始 history、catalog 与上游持久化 store 是重新进入/刷新的恢复来源。

真实服务图与系统边界计数：

| 场景 | 结果 |
|---|---|
| 连续访问 6 个 idle scope | 原实现 dispose 0；修复后按顺序 dispose 1/2/3，仅 3 个 idle client |
| 触及缓存 scope 4 后访问 7 | 淘汰 scope 5；重入 scope 1 时 create 累计 2 次 |
| busy scope + mounted scope + 4 idle scope | 仅淘汰最旧 idle；busy 解除后才进入 LRU，TTL 不卸载 mounted seat |
| 连续访问 7 个 Session | 原实现 7 个 binding；修复后 4 个，重入已淘汰 Session 的 follow 增加 1 次；无 session cancel |
| request/stream/interaction/submission/running/mainView/attachment/draft（8 类） | 每类均保留 1 个受保护 binding + 4 idle；保护解除后回到 4 idle，受保护 generation 在此之前未替换 |
| TTL 与恢复 | 5 分钟后 idle binding 消失；重开 follow 后真实原组件 textbox 恢复 `survives idle eviction` |

## 验证与限制

- `npx vitest run packages/dsh-ui/adapters/index.test.tsx packages/dsh-ui/client-bootstrap.test.tsx --maxWorkers=1`：33/33 通过（index 5 + bootstrap 28）。包含原始原组件双 Session、草稿、事件桥、关闭/切换、空白会话与 stream 清理回归。
- `npm --prefix packages/dsh-ui run check:adapters`：通过；39 source entries、1045 modules，无未解析浏览器依赖/ModuleLoader。
- `git diff --check`：仅指定文件检查；没有修改 vendor、transport、原生文件或提交。
- 验证期间一次磁盘 ENOSPC 阻止 Vite 启动，随后空间恢复后重跑通过；失败未执行用例，不作为代码失败或通过证据。
- 预算是 **idle** 实例数量，活动/受保护实例可超过该数，不能靠丢请求、流或输入强行压到总量。未测真实 WebContent RSS，实际系统内存仍由主 agent 集中实机验收。
- 当前定向测试验证重新进入的持久化恢复；没有启动应用做 OS 刷新/进程退出，原生退出由主 agent 负责。
