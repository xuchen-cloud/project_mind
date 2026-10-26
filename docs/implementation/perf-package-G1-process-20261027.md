# G1：DSH 原生进程生命周期

基线 `5de9a91`，共享分支 `fix/performance-review-20261027`。关联 #112/#249/#250 与 performance-audit 的 DSH 强制退出残留。与 `perf-package-G1-20261027.md`（client/session 驻留）分开记录；主 agent 统一整合和提交。

## 范围与验收

- 依赖固定 Node 24.21.0、pinned `LocalSubprocessRuntime` 的 `internals.spawn` 接缝、node-pty 和原生退出事务。
- 交付：普通 provider detached、PTY 新 session、常见 shell/background 树在正常关闭、实际 8 秒超时、Drop、Node SIGKILL 及原生父进程 SIGKILL 时回收；保留 stdout、退出码和额外控制 FD；退出未完成时恢复请求准入。
- 非目标：任意用户程序 daemon 的通用安全沙箱、全机杀进程、Office 进程实现、client/session 缓存。没有修改 node_modules、提交或启动应用。

## 文件与实现

- `src-tauri/src/dsh_process.rs`：生命周期容器，Unix 启动独立 guardian，Windows Job 包装；清理失败向调用方返回错误。
- `src-tauri/src/dsh_process_unix.rs`：原生 helper/exec shim、private SID sentinel、guardian socket 与 app lifetime pipe。
- `src-tauri/src/dsh_process_windows.rs`：复用现有 kill-on-close Job；另用 duplicated process handle 等待 Node 退出后关闭 Job，避免 native app 仍活着时 Node SIGKILL 留下工具。handle 固定真实进程身份。
- `src-tauri/src/dsh_assistant.rs`：production runtime 启用 guardian，启动/configure 前建立归属，正常 stop 和 8 秒后强杀均等待 native cleanup，Drop 关闭 lifetime pipe；shutdown 返回 RAII `ShutdownLease`，stop Err、后续退出步骤失败、future 取消均恢复准入，最终 `commit()` 才保持关闭。F 接入统一退出事务。
- `src-tauri/src/lib.rs`/`main.rs`：仅本模块导出及 Tauri 初始化前 helper 分派；F 的 voice helper 分派保留。
- `packages/dsh-assistant/scripts/process-ownership.mjs`/`runtime.mjs`：provider ordinary spawn 注入 shim；PTY 在上游 shell activity argv 准备后，通过 AsyncLocalStorage 截取实际 node-pty spawn。保留 D 的 session-fork import/install。
- `packages/dsh-assistant/test/process-ownership.test.mjs` 与 `test/fixtures/process-{guardian.rs,host.mjs,native-host.mjs,linux-scope-host.mjs,linux-systemd.mjs}`：真实 provider、PTY、控制管道、8 秒/Drop 测试夹具。

### Unix 归属与资源约束

1. exec 前双 fork 原生 sentinel，注册 ACK 后才允许目标程序执行；目标 PID、stdio、退出码不变。sentinel 与目标同 SID、独立 PGID，保持 SID 不能被其它应用复用。
2. sentinel 注册前先 drop 空设备对象，再关闭所有继承的 fd >=3。不会持有工具 fd3/fd7、Node IPC 或 app control pipe。Darwin SIGSTOP=17，Linux=19。
3. macOS kqueue / Linux pidfd 阻塞等待进程退出或 lease 关闭；没有 idle `ps` 轮询。退出/清理时才取一次进程表并以 SID 筛选，冻结后再取快照捕获冻结前 fork。
4. 清理子进程用 `setpgid` 加入待杀 PGID；内核拒绝跨 SID。随后该 owned child 停住自己并 pin 住 PGID，再由 sentinel 信号/回收，避免 PID/PGID 复用误杀。
5. guardian 最多 256 session lease、258 活动连接；新增连接时回收已完成 handler，初始帧有 5 秒期限。帧上限 512 字节；JS pending 和 pin receipt/waiter 也有上限。PTY pin 失败关闭 observer，由 native guardian 回收已启动 terminal，避免上游 terminate 把 sentinel 一起杀掉。
6. guardian 必须收到 sentinel 的 `DONE`，才报告 cleanup 成功；丢失确认/清理超时显式失败。

## 已验证事实与边界

**本机 macOS 实证覆盖 provider 自己创建的 detached/PTY session，以及仍留在这些 SID 内的常见工具树。不能声称任意后代清零。**

在 macOS/session fallback 路径，真实工具内部 `spawn(..., {detached:true})` 会再次执行 setsid：宿主被 SIGKILL 后，provider root 被清理，该 daemon 仍存活。回归专门断言此边界，finally 只清理测试记录的 daemon PID。若业务明确需要驻留 daemon，应给该服务独立的原生生命周期/租约；本包不扩大成任意后代沙箱或全机搜杀。

按主审决策，已撤掉强制 fallback。保留 pinned provider 每次启动时的真实能力探测及返回值：Linux systemd 可用时 ordinary 和 PTY 仍进入 `linux-scope`；只有 provider 自己选择 fallback 时才注入 session shim。普通 spawn 的 `internals.spawn` 本来就只在 fallback 分支使用；PTY 通过 AsyncLocalStorage 观察原选择函数的返回值，native scope 原样启动并返回原 handle，不注册 SID sentinel、不修改 inspector，也不干扰 `TasksCurrent`。

原生 scope 继续由 pinned `SystemdScopeOwner` 执行 `systemctl kill --kill-whom=all`（含 SIGKILL）、观察 `TasksCurrent`、等待 `waitForExit()` 及清理空 scope；本包不替换这些调用。guardian 继续保护宿主与 fallback session。本机对 Linux 分支用进程化命令夹具验证能力选择和原清理委派，未运行真实 Linux systemd manager，不能将夹具结果表述为 Linux SIGKILL/cgroup 实机通过。Windows Job 仅完成源码实现和语法检查，未在 Windows 实机验证。

## 验证

### 红例

`src-tauri/resources/agent-host/node $TMPDIR/dsh-owned-host-red.mjs` 使用真实 pinned provider，实际 detached child 创建后 SIGKILL Node：

```json
{"hostKilled":true,"ownedAlive":true,"actualPinnedProvider":true,"detached":true}
```

断言“宿主 SIGKILL 不应留下 detached child”失败；finally 只清理夹具自己记录的 PID/PGID。

### Rust 定向

主协调后由本 agent 唯一 Cargo runner，`CARGO_INCREMENTAL=0 TMPDIR="$TMPDIR" cargo test --manifest-path src-tauri/Cargo.toml --lib -- ... dsh_process_ ...`，日志 `$TMPDIR/mind-C-G1-G2-targeted.log`，5/5：

- `dsh_process_normal_shutdown_cleans_actual_provider_detached_child`
- `dsh_process_eight_second_timeout_cleans_actual_provider_detached_child`：实测等待 >=8 秒、总清理 <14 秒。
- `dsh_process_drop_cleans_actual_provider_detached_child`
- `dsh_process_failed_shutdown_restores_admission_and_success_keeps_it_closed`
- `dsh_process_cancelled_shutdown_restores_admission`

真实 normal/timeout/Drop 夹具也设置原 command `process_group(0)`；guardian 重建启动命令后实际 setsid 成功。F 后续又验证统一退出 helper 的 Skills/DSH 后阶段失败恢复，结果由其独立记录。

### 固定 Node 定向

`src-tauri/resources/agent-host/node --test packages/dsh-assistant/test/process-ownership.test.mjs`：**10/10**，约 3.47 秒，日志 `$TMPDIR/mind-G1-process-final.log`。

覆盖 actual tool ready 后 Node SIGKILL 的普通/PTY 子进程；原生 parent SIGKILL；stdout/退出码23与 fd3/fd7 EOF（sentinel 因 background 仍活着）；zsh idle；shell/background 树与其它 application 不受影响；daemon SID 边界；超长无换行帧；PTY job-control 独立 PGID；目标已执行后的 pin 失败。Mac 自带 bash3.2 不支持 upstream shell activity hook，交互活动测试使用支持的 zsh；Windows 跳过这些 Unix 回归。

`rustfmt --emit stdout --config skip_children=true` 解析通过，未整体格式化共享 Rust 文件。`git diff --check` 通过。没有运行全量测试或启动应用。


### Linux systemd 保留修复

先读取实际 pinned `@deepseek-ai/dsh-subprocess-local` 0.2.0-rc.2：ordinary 的 `spawn` 在 native 分支不传 `internals.spawn`，PTY 的 `prepareLinuxTerminalScope` 直接启动 `systemd-run` 并绑定 `SystemdScopeOwner`；`disposeManagedProcesses` 保留 terminate + done/waitForExit，terminal terminate 同样等待 native managed range。

先补回归执行：

```sh
src-tauri/resources/agent-host/node --test --test-name-pattern='Linux .*pinned' packages/dsh-assistant/test/process-ownership.test.mjs
```

原接入 3/3 失败（ordinary/terminal 被改选 fallback，manager unavailable 场景也覆盖原 selector）；红例日志 `$TMPDIR/mind-G1-linux-scope-red.log`。修复后相同三类回归全部通过，日志 `$TMPDIR/mind-G1-linux-scope-green.log`。

回归使用真实 pinned provider 与真实 native 分支/cleanup 方法，只将当前测试子进程 PATH 中的 systemctl/systemd-run 换成进程化夹具：不接触系统 manager、真实 user unit、vendor 或 node_modules。ordinary 与 PTY 都证明 native mode 保留、scope launcher 确实被调用、未请求 fallback pin、SIGKILL 仍针对 all members，且 managed-range wait 确实执行；manager 不可用时真实轻量 recheck 才返回 fallback。夹具启动并清理自己记录的独立 session 目标，finally 仅处理自身 PID。

本次仅修改 JS 接入、其测试/新夹具和本记录，没有运行 Cargo，没有影响主 agent 的 Rust 全量。`src-tauri/resources/agent-host/node --test packages/dsh-assistant/test/process-ownership.test.mjs` 合并定向 **13/13通过**，约3.33秒；原有macOS 10项无退化，新增Linux分支3项通过，日志 `$TMPDIR/mind-G1-process-linux-final.log`。JS已冻结，供主agent继续DSH全量。文档的临时目录统一以 `$TMPDIR` 代称，空设备使用名称描述，原4处portable-path违规已清除。
