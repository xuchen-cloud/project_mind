# Project Mind 重复操作与资源生命周期性能审计

> 本文保留审计基线的发现与原始计数。修复进度、最终验收和当前状态见 [统一执行记录](../implementation/performance-review-fixes-20261027.md)；相邻 probes 脚本现断言修复后的预期行为。

后续已按扩展要求补审 GenOffice、语音记录、文件版本管理和 AI 助手相关能力，新增 11 项发现及 4 组计数实验。请同时阅读[扩展审计](performance-audit-expanded-20261026.md)；其中细化了本篇原列为待实机预算验收的 Office 路径。

日期：2026-10-26。开始审计时已 fetch，远端 `origin/develop` 为 `10382cad15e9af2fd38db275570ac1fa932485d8`。收口期间文件发现修复 `277ce19f359c1d18547876293ad028dc0fb943b2` 随 [PR #272](https://github.com/xuchen-cloud/project_mind/pull/272) 合并。最终审计覆盖本地 HEAD 与 `origin/develop` 的 `5de9a91692136d378fd4595716109bf7c25e4d22`；其代码树与已补审的 `277ce19` 相同。

主要风险集中在三类放大：每次变化重做全部历史、逐项操作内部再次遍历全集、关闭页面后仍保留没有容量上限的运行状态。语音回放、会话搜索和 DSH 强制退出已有隔离实验支持；其余发现按真实调用链说明触发条件，不把定时器数量直接当成 CPU 测量结果。

## 范围和交付

- 范围：语音录制、识别、字幕和回放；文件发现与目录树；Skills；定时任务；Session；缓存与页面驻留；GenOffice；退出清理。
- 关联议题：[#271](https://github.com/xuchen-cloud/project_mind/issues/271) 的静态重扫与重复日志修复已随 PR #272 合并；[#249](https://github.com/xuchen-cloud/project_mind/issues/249) 涉及定时任务面板；GenOffice 历史性能验收见 [已有记录](../implementation/office-first-open-performance-20261018.md)。本次没有新建或关闭议题。
- 依赖：现有代码和安装的 DSH 依赖；复用现有测试与历史实机证据。
- 交付：按优先级记录触发路径、重复成本、证据、修复方向和验收条件。
- 非目标：本次不修改产品行为，不发布版本，不操作用户正在运行的应用。
- 验收：覆盖上述模块，明确正常退出与异常退出的区别，区分当前提交、并行未提交修改、计数实验和历史实机数据。

审计期间其他工作修改了文件发现、旧版 File 登记、相关需求和依赖，最终形成 `277ce19`。本次补审其生产代码变化并区分修复前后行为，没有改动该工作。语音、DSH、前端和 Node 依赖未被这个提交修改，对应审计与已通过检查继续有效。文件发现自身验证记录见 [#271 需求的执行证据](../requirements/project-file-discovery-events-20261026.md)。

## 优先级总览

P1 表示应优先处理的放大成本或资源回收缺口；P2 表示明确存在重复工作、需要结合数据规模设定预算的优化项。

| 优先级 | 模块 | 重复操作及影响 |
| --- | --- | --- |
| P1 | 语音回放 | 新增音频块就重新读取、解码和扫描全部历史音频，累计工作随块数平方增长 |
| P1 | 语音状态切换 | 在 Workspace 和 DB 锁内等待模型初始化、识别排空与线程退出 |
| P1 | 会话搜索 | 每个候选会话两次归属校验，各自重新读取完整会话目录 |
| P1 | 会话列表 | 每次刷新依次恢复所有冷会话的 projections，可能击穿小容量冷读缓存 |
| P1 | DSH 退出 | 超时强杀仅覆盖 Node 宿主，隔离实验中其子进程继续存活 |
| P1 | DSH 驻留 | 访问过的项目客户端和会话被保留到 Workspace 关闭，没有数量或内存预算 |
| 已修正 | 文件发现静态轮扫 | `277ce19` 改为事件唤醒，静止时只做 SQLite 项目目录检查 |
| P2 | 文件分页 | 每页限制保留条目，却仍完整枚举目录；宽目录重复枚举放大 |
| P2 | 目录树 | 每个展开目录独立每 3 秒重新列举和校验路径 |
| P2 | 本地实时字幕 | 每 2 秒重识别增长中的片段，并同步等待识别结果 |
| P2 | 语音渲染与轮询 | 回放逐帧重渲染转写列表；多个状态消费者重复轮询，慢调用可能重叠 |
| P2 | 后台维护 | 空闲时仍周期性获取锁、查库、遍历 Project 或读盘 |
| P2 | 会话内容分页 | 每一页内容查询重新检查所有候选会话，输出预算没有约束扫描工作 |
| P2 | Skills | 反复打开、切换范围会重复启 Node、准备内置链接并重建发现上下文 |
| 待实机预算验收 | GenOffice | 缓存有上限，多个驻留编辑器的总量和连续开关内存仍需验收 |

## P1 语音回放新增分块触发全部历史解码

位置：[VoiceRecordPanel.tsx](../../src/components/voice/VoiceRecordPanel.tsx) 的 playback effect，约 213 行；[voice-player.ts](../../src/lib/voice-player.ts) 的 `load`，约 15 行；[storage.rs](../../src-tauri/src/voice/storage.rs) 的 `CHUNK_SECONDS`。

录制和暂停状态下，回放 manifest 每秒查询。`chunks` 变化后 effect 销毁旧播放器并创建新播放器，`load` 对所有块执行 `fetch` 和 `decodeAudioData`，之后逐个声道、逐个采样计算峰值。块约每 60 秒落盘，因而长期录制期间不断重做先前历史。React Query 对未变化的数据有结构共享，不能将其描述为“每秒都解码全部音频”。

计数实验使用实际 `VoicePlayer` 源码，替换浏览器音频与文件读取边界：模拟 60 次 manifest 更新，每次新增两个块。120 个不同块累计触发 **3,660 次 fetch 和 3,660 次解码**，最大同时处理 120 块。该实验验证调用次数，没有模拟真实音频的解码耗时。

`Promise.all` 没有并发窗口；全部解码后的 AudioBuffer 常驻播放器，峰值扫描在 WebView JavaScript 线程执行。按一小时、两个单声道来源、48 kHz、float32 解码估算，音频样本本身约 **1.29 GiB**，尚未计入原始字节、解码中的副本、其他页面与引擎内存。这是容量推算，不是实测 RSS。

修复方向：根据稳定分块身份增量处理；峰值每块只计算一次；按播放位置维护有预算的解码窗口，限制并发。原始双路音频和时间轴保持完整。

验收：增长到 120 块时，每个未修改块只读取和解码一次；一小时录音的解码驻留量受窗口预算约束；加载中切页、追加块和暂停恢复保持正确时间轴，结束后不再无效刷新。

## P1 语音状态切换在全局锁内等待模型与线程

位置：[commands.rs](../../src-tauri/src/voice/commands.rs) 的 `with_voice_db`，约 65 行；[runtime.rs](../../src-tauri/src/voice/runtime.rs) 的 `start`、`resume`、`prepare_recognition`、`stop_capture_run`；[local_asr.rs](../../src-tauri/src/voice/local_asr.rs) 的 `LocalAsrWorker::start`；[live_local.rs](../../src-tauri/src/voice/live_local.rs) 的 `finish`。

`with_voice_db` 持有 `voice_runtime`、`current_workspace` 和 Workspace DB 锁后执行完整操作。开始、恢复时会在此范围内等待 ONNX 模型初始化的 `recv()`；暂停、结束涉及捕获停止、写入收尾和识别线程 `join()`。本地识别排空没有固定时间上界。

因此，慢模型加载或积压识别会占住其他功能也需要的锁，放大为目录、会话相关原生操作和 Workspace 切换等待。暂停后恢复还会重新准备识别工作器。这里能证明锁的覆盖范围；尚未测量各设备的实际停顿时长。

修复方向：在锁内提交短状态转换，模型准备和排空放到锁外；跨异步边界后核验 Workspace generation 与录制状态，再提交结果。评估识别器在同一录制生命周期的复用。不能用超时丢弃已录制音频替代完整收尾。

验收：人工阻塞模型初始化或识别排空时，其他 Workspace DB 读取能够完成；切换、取消与结束仍保持归属、音频落盘和转写一致性。

## P1 会话搜索逐项归属校验反复读取全集

位置：[context-session-reads.mjs](../../packages/dsh-assistant/scripts/context-session-reads.mjs) 的 `searchContextSessions`，约 18 行；[project-workspace.mjs](../../packages/dsh-assistant/scripts/project-workspace.mjs) 的 `scopeForSession`，约 109 行。

搜索先获取目录，再逐会话查询内容。每项在内容读取前后各调用一次 `registry.forSession`；其实现都重新调用原始 `sessionList` 获取全部会话，再查找一个 ID。没有命中或命中较晚时，最多 20 条结果的限制不能限制候选遍历。

使用实际 `bindContext` 与实际搜索函数的合成目录计数结果：

| 输入 | 完整目录读取次数 | 内容过滤次数 | 至少遍历的目录行数 |
| --- | ---: | ---: | ---: |
| 20 个会话，无命中 | 41 | 20 | 820 |
| 100 个会话，无命中 | 201 | 100 | 20,100 |

这是明确的嵌套全集读取；原始列表还涉及持久化头信息与排序，实际成本不只是 Map 查找。

修复方向：使用有版本的会话归属索引或一次请求内的目录快照，跨内容 I/O 后校验目标会话与范围是否变化，避免重复重建全集。保留归属校验、归档撤销与取消语义。

验收：无命中搜索的目录读取次数不随候选数量线性增加；跨查询期间移出范围、归档、删除的会话仍不泄露结果。

## P1 会话列表重复串行恢复冷会话

位置：[project-workspace.mjs](../../packages/dsh-assistant/scripts/project-workspace.mjs) 的 `sessions.list`，约 145 行；[session-controller](../../packages/dsh-ui/upstream/api/session-controller/src/index.ts) 的 projections 路径。安装的 `dsh-session-query/lib/index.js` 中冷观察默认缓存容量为 5。

列表对当前范围内每个 `agentAvailable === false` 的会话，串行调用 `sessions.projections`。没有先检查列表项是否已有可用的标题投影；再次刷新仍重复全部调用。实际函数计数实验中，100 个冷会话连续请求两次列表，产生 **200 次 projections 调用**。

冷观察缓存虽然会按 revision 复用，但只有 5 个非固定项。会话数超过容量、且每次按相同顺序全部恢复时，会发生循环淘汰，先前已读历史可能再次恢复。不能把“接口有缓存”视为这个遍历已经低成本。

修复方向：列表使用已持久化且版本有效的标题元数据，只为缺失项补齐；需要正文的选中会话再恢复完整状态。定时任务面板也读取会话列表，其新建下拉和手动刷新会承受此成本。

验收：100 个未变化的冷会话第二次读取列表不再全量恢复正文；标题更新与删除后正确失效，单个会话异常不能被静默吞掉。

## P1 DSH 强制退出未覆盖整个进程树

位置：[dsh_assistant.rs](../../src-tauri/src/dsh_assistant.rs) 的 `launch_with_registry`，约 503 行，`stop_child` 约 1205 行，`exit_fallback` 约 1529 行；[runtime.mjs](../../packages/dsh-assistant/scripts/runtime.mjs) 的 stop；对照 [office_process.rs](../../src-tauri/src/office_process.rs)。

正常路径写入 `shutdown`，Node dispose 会释放 subprocess provider；Rust 最长等待 8 秒后调用 `Child.kill()`。启动时设置了 `kill_on_drop`，但 DSH 宿主没有原生进程树容器。直接杀 Node 不保证杀掉它已经创建的 Shell、工具等后代。Node 的正常退出钩子可以帮助清理，但无法覆盖 SIGKILL、崩溃或事件循环失去响应。

隔离实验使用仓库已安装的真实 `LocalSubprocessRuntime` 和固定 Node 24.21.0，启动可追踪的 Shell/sleep 子进程：

| 宿主结束方式 | 宿主结束后测试子进程存活 |
| --- | --- |
| 正常 EOF 并 dispose | 否 |
| SIGKILL | 是 |

实验结束清理了实验自身的子进程，没有终止用户应用。这复现的是实际 provider 的宿主清理边界，尚不是完整打包 App 的退出验收。强制停止 App 后，Node 宿主自身的存活情况还取决于退出路径；现有 `kill_on_drop` 不能单独证明整个树已清空。

本机两个 DSH Node 进程的父进程都是仍在运行的旧 Project Mind 测试二进制，不能据此判定为“最新版本退出后的残留”。独立运行的 DSH Desktop 也不属于本应用残留。

修复方向：把 DSH 宿主及工具后代纳入原生生命周期管理；Windows 评估 Job 的 kill-on-close，macOS 覆盖 provider 创建的独立进程组。Office worker 已有 Unix 进程组和 Windows Job 保护，可复用设计经验；简单给外层 Node 加一个 Unix 进程组并不能覆盖另建组的后代。

验收：真实打包 App 分别执行正常退出、Workspace 关闭、超时回退、宿主崩溃、强杀；包含多层 Shell 和独立进程组。检查应用拥有的 PID、监听端口和文件句柄归零，避免误杀其他应用的 Node。

## P1 DSH 项目和会话驻留没有容量预算

位置：[adapters/index.jsx](../../packages/dsh-ui/adapters/index.jsx) 的模块级 `clients` 与 `release`，约 9、30 行；[adapters/client.jsx](../../packages/dsh-ui/adapters/client.jsx) 的 `residentSessions` 和 `selectSession`，约 65、246 行；对照 [resident-pages.ts](../../src/lib/resident-pages.ts)。

项目页释放后只减少 `users`，项目客户端图仍保留至 Workspace teardown。每个访问成功的会话又额外 `retain(... source: 'projectContent')`，记录到 Map；关闭 UI 的选择句柄不会撤销这个驻留句柄。

Project shell 虽有最多 4 个 warm 加 1 个 active 的限制，DSH 客户端和会话 Map 不受此限制。用户轮流打开多个 Project、Session 后，内存、订阅和目录更新处理可以持续增长。这是无预算的保留策略，不能仅凭代码称为不可回收内存泄漏。

修复方向：区分正在运行、存在待提交内容、可安全冷却的会话；为后者设置容量和释放策略。项目图用户归零且没有运行任务时进入受预算的冷却。释放后通过持久化内容恢复，避免损失会话状态。

验收：轮流访问至少 100 个会话和超过 shell 上限的 Project 后，非运行驻留数有固定上界；关闭 Workspace 后客户端、订阅和持有句柄全部释放；运行中的任务不被淘汰。

## 已修正 静态文件发现从轮扫改为事件唤醒

位置：[基线 project_file_maintenance.rs](https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/project_file_maintenance.rs)，`POLL_INTERVAL`、`Driver::step` 和后台循环。

基线每页处理最多 5 个新 File，忙时隔 250 ms 调度；一个范围完成后约 5 秒进入下一轮。Workspace 内 Project 轮转，即使文件没有变化也继续发现扫描。错误去重只记录最近一条字符串，多个页面上的不同持久错误可以交替再次输出。

[#271](https://github.com/xuchen-cloud/project_mind/issues/271) 的修复已进入 `277ce19`：先订阅再首次扫描；后续由原生目录事件设置范围 dirty 并唤醒；静止时每 5 秒仅做 SQLite 项目目录检查；读访问、隐藏和内部路径、临时文件被过滤；错误按文件与原因跨页去重。本次补审确认这些变化，因此静态重扫不再列为当前 HEAD 的未修复问题。

该工作已记录 165 项通过、6 个既有辅助项 ignored 的针对性验证及静默编译通过，本次复用其 [执行记录](../requirements/project-file-discovery-events-20261026.md)。真实 Windows CPU 验收仍应使用新二进制与采样证据；代码合并与发布后的实机效果分别判断。

## P2 文件分页仍重复完整枚举宽目录

位置：[project_directory_files.rs](../../src-tauri/src/db/project_directory_files.rs)，分页发现中的 `entries_cache` 和 `fs::read_dir`，约 1548 至 1593 行；新文件登记约 381 至 418 行；[project_file_maintenance.rs](../../src-tauri/src/project_file_maintenance.rs) 的 `business_event` 和 dirty 处理。

每页的目录缓存只存活到该页结束。为选择游标后的最小 128 个名字，会遍历 `read_dir` 返回的全部条目，然后用 BTreeMap 保留前 128 个。下一页重新从目录开头枚举。

对于包含 N 个已知文件的宽平目录，一轮约需 N × ceil(N/128) 次目录条目枚举，而不是 N 次；新增文件还受每页 5 个处理预算影响。单页保留内存有界，没有使单页文件系统工作有界。扫描又处在当前 Workspace 和存储作用域内，慢目录会延长锁占用。

`277ce19` 已消除静态重复轮扫，但初次扫描与脏范围重扫仍会遇到此问题。事件目前合并为整个 Project / Workspace File 范围的 dirty；已登记普通文件的内容修改也可以触发新一轮范围扫描。连续编辑或构建写入时，需要关注“扫描期间又变脏，再完整扫一轮”的成本。

首次登记还有一层放大：`project_file_register` 对每个候选 SELECT 全部非图片 documents，再逐项比较路径或读取物理身份。F 个新文件、D 条现有记录可能产生 O(F×D) 身份探测，批量初次纳管随着记录增长可接近平方工作量。这些身份检查保障硬链接和真实归属，优化应使用可靠索引，不能直接删掉。

修复应考虑有界的增量枚举状态、受验证的事件路径队列和物理身份索引，保留目录归属与路径安全检查。仅降低全范围重扫频率不能消除宽目录和批量登记的放大。

验收：大平目录初次扫描、单文件变化、扫描期间目录变化和取消均有条目读取预算；记录每页真实枚举数与锁持有时间，不能只断言返回 File 数不超过 5。

## P2 每个展开目录独立每三秒刷新

位置：[ProjectDirectoryBrowser.tsx](../../src/components/home/ProjectDirectoryBrowser.tsx) 的 `DirectoryBranch`，约 34 行；[project_directory.rs](../../src-tauri/src/project_directory.rs) 的 `list` 和 IPC，约 121、308 行。

每个已挂载目录分支各有一个 `refetchInterval: 3000`。原生列表每次重新读取目录、获取子项信息、解析和校验路径，再排序。展开 50 个分支约产生每分钟 1,000 次列表请求；这是频率推算，尚未做目录实机耗时测量。

目录树前台挂载时存在此放大；React Query 的失焦行为会影响后台轮询，不能声称所有最小化场景都继续相同频率。路径归属校验本身有必要，优先消除没有变化时的整目录重做。

修复方向：同范围订阅变更并合并失效，只刷新受影响展开目录；为仍需轮询的路径设置共享调度与并发上界。

验收：静态展开树不持续产生完整列举；单目录变更不刷新全部分支；折叠、换 Project、关页后不再产生该分支请求。

## P2 本地实时字幕重复识别增长中的片段

位置：[live_local.rs](../../src-tauri/src/voice/live_local.rs) 的 `PREVIEW_INTERVAL_SAMPLES`、`feed_mixed`、`preview`，约 23、331、385 行；[recognition.rs](../../src-tauri/src/voice/recognition.rs) 的 `SegmenterConfig` 和 `preview`。

启用字幕预览后，约每 2 秒复制当前整个未结束语句，再提交 SenseVoice。新的预览包含前一次已识别的前缀；最终片段仍再次识别。默认切段上限是 **10 秒**，不能把识别工作器允许的 30 秒输入上限当成实际默认切段时长。

预览和最终提交都同步 `recv()` 等待识别结果。ONNX 虽在工作线程执行，喂入与分段线程仍等待，慢设备会推迟输入排空。真实积压程度与 VAD 分段、字幕开关和设备速度有关，本次没有推断为原始录音丢失。

修复方向：预览最多一个在途任务，合并已过时预览，最终片段优先；评估支持增量状态的识别接口。保留原始录制、可恢复日志和最终转写完整性。

验收：慢识别器下不积累过时预览；最终片段及时处理；关闭字幕停止预览推理；暂停和结束仍能完整收尾。

## P2 语音播放逐帧重绘转写且状态轮询可能重叠

位置：[VoiceRecordPanel.tsx](../../src/components/voice/VoiceRecordPanel.tsx) 的 `speakerLabel`、播放 RAF 和转写列表，约 132、264、455 行；[VoiceFloatingPanel.tsx](../../src/components/voice/VoiceFloatingPanel.tsx) 约 45、91 行；[VoiceCaptionWindow.tsx](../../src/components/voice/VoiceCaptionWindow.tsx) 约 31、91 行。

播放期间每个 animation frame 更新整个面板的 `positionMs`。展开的转写列表随之重新 flatMap 和渲染；说话人就绪时，每段又对全部 diarization turns 过滤。载入 S 段转写、T 个说话轮次时，每帧相关计算可以达到 O(S×T)。没有把播放时钟更新隔离到进度组件。该 RAF 不依赖 `visible`，应明确隐藏页的播放和更新策略；浏览器自身可能节流隐藏场景。

主窗口浮层在平台支持时，即使没有当前录制也每秒请求 snapshot。字幕窗口另有独立每秒请求。两者的 `setInterval` 都直接启动 async refresh；sequence 只丢弃过期结果，不取消已进入原生端的操作。当一次调用超过一秒时，下次仍会进入，形成重叠并竞争同一组锁。正常快速调用不等于必然重叠。

后端还有每 250 ms 的 supervisor，因此同一状态被多处周期性读取。Voice Record 在暂停时仍每秒查 playback；已完成的 minutes 和 recovery 也有持续 5 秒查询路径。

修复方向：进度条隔离更新；转写行和说话人重叠关系按数据 revision 计算一次；快照通过变更事件分发并在需要时补读。保留轮询时使用一个在途调用和完成后调度，隐藏页、无录制和终态明确停更条件。

验收：长转写播放时，转写列表渲染次数不随帧率增加；人为延迟 IPC 时同一消费者最多一个在途 refresh；无录制、关字幕窗口与关闭 Record 后停止对应工作。

## P2 空闲维护仍周期性查库与轮转

位置：[lib.rs](../../src-tauri/src/lib.rs) 约 1500、1514 行；[source_maintenance.rs](../../src-tauri/src/source_maintenance.rs) 约 190 行与 [DB 实现](../../src-tauri/src/db/source_maintenance.rs) 的 `source_maintenance_next`；[overview_maintenance.rs](../../src-tauri/src/overview_maintenance.rs) 约 948 行；[dsh_schedules.rs](../../src-tauri/src/dsh_schedules.rs) 约 67 行。

| 循环 | 无变化时仍可能执行的工作 |
| --- | --- |
| record checkpoints 每 1 秒 | 获取当前 Workspace 和 DB 锁，查询待封存检查点 |
| voice supervisor 每 250 ms | 获取语音、Workspace、DB 锁，查快照、恢复及 diarization 待办 |
| source maintenance 每 500 ms | 没有前台占用或预算阻挡时，遍历活动 Project，检查设置与工作队列 |
| overview maintenance 每 2 秒 | 查询可恢复任务与下个符合条件的范围 |
| DSH schedule restore 每 15 秒 | 读取并解析任务 JSON，然后才检查和复用已存在的宿主 |

语音 supervisor 理论每小时唤醒 14,400 次；source 检查在无任务时仍随 Project 数增长。不能仅凭此断言高 CPU，更不能据此归因公司安全软件的 CPU。

修复方向：由业务提交、任务变化、模型解锁与 Workspace 生命周期发出通知；到期任务按最近 deadline 唤醒。恢复检查可保留必要的低频校准，避免每次读取完整集合。先记录空闲 SQL 数、读盘数、锁等待和唤醒次数。

定时任务 Node 执行器本身已有串行链和按下一到期时间 `setTimeout`，没有发现“每秒轮询并不断重复启动任务”的代码。任务面板当前先展示任务，再独立取会话，并监听 focus 和任务变更；主要放大来自前述会话列表路径。不能将两种调度机制混为一谈。

验收：零任务、关闭语音、静态多 Project 场景长期空闲的操作数量有固定预算；新任务、到期任务与崩溃恢复仍按规格触发；无重复执行。

## P2 会话内容分页每页重新扫描所有候选历史

位置：[session-inventory.mjs](../../packages/dsh-assistant/scripts/session-inventory.mjs) 约 28 至 64 行。

存在 `contentQuery` 时，不论游标是否已越过该会话、当前页是否已满，都调用 `sessions.inspect`、构建完整对话文本并匹配，以计算总数。最后再次读取全部目录校验 snapshot。`budgetChars` 约束返回内容，不约束前面已经做过的历史恢复与文本扫描。

实际函数合成实验：100 个内容都命中的会话，每页 20 项连续取 5 页，产生 **500 次 inspect 和 10 次目录读取**。这与页面只返回 100 项的直觉差距明显；底层缓存能减少部分 I/O，不能消除反复构造文本和检查的工作。

修复方向：按范围和内容 revision 建立查询结果快照或使用已有搜索索引；游标继续相同查询时复用命中集合。权限撤销与内容变化要使查询快照正确失效。

验收：未变化集合连续翻页不再次 inspect 已扫描的全部历史；预算同时覆盖扫描成本与输出；目录或权限变化仍拒绝旧游标。

## P2 Skills 重复打开会重新启动完整发现

位置：[SkillsPanel.tsx](../../src/components/settings/SkillsPanel.tsx) 的 `SkillsCatalog`，约 70 行；[skills.rs](../../src-tauri/src/skills.rs) 的 `run_catalog`，约 164 行；[skills.mjs](../../packages/dsh-assistant/scripts/skills.mjs) 的 `collect`、`discoverSkills`；[builtin-skills.mjs](../../packages/dsh-assistant/scripts/builtin-skills.mjs) 的 `prepareBundledSkills`。

Skills 面板没有定时刷新。反复打开、切换发现范围或手动刷新会创建新的 Node 目录进程，准备和检查内置链接，创建 registry/provider 获取活动快照，再为各个根的 `.disabled` 创建发现上下文。每次上下文都有 dispose，因此不属于无限保留 watcher 的问题。

前端 generation 在卸载时只忽略旧结果，没有撤销已发出的目录进程。快速切范围时多个扫描可并行消耗文件 I/O。管理操作在修改前后各发现一次，是为新鲜校验和返回更新结果，不能在没有等价校验的情况下简单删除。

另一个按读取发生的放大点是 `isSkillResourceRead`：遍历候选时反复 realpath 同一个请求目标，候选越多，边界检查 I/O 越多。应保留修改或外部 I/O 后必要的归属重验。

修复方向：同一范围的并行列表请求合并；目录列表采用有失效规则的短期缓存；取消无消费者的发现；同一轮边界检查复用已经确定的路径值，并在实际读取前做必要复核。

验收：快速切换范围、反复开关面板时，旧扫描退出且同范围不重复并发；启用、禁用、删除和导入后立即正确失效；不把过期目录结果用于管理授权。

## GenOffice 驻留总量和连续开关仍需实机验收

位置：[office-preview-cache.ts](../../src/lib/office-preview-cache.ts)、[OfficeFileContent.tsx](../../src/components/office/OfficeFileContent.tsx) 约 114 行、[ProjectFileContent.tsx](../../src/components/document/ProjectFileContent.tsx) 约 157 行，以及 [既有性能记录](../implementation/office-first-open-performance-20261018.md)。

预览模型缓存已有 **16 MiB、最多 4 项**的上限，并按 Workspace generation 清空。三类编辑器也有卸载时 destroy、dispose、关闭消息通道等清理逻辑。没有依据将其直接描述为“缓存无限增长”或“关闭后必然泄漏”。

需要继续验收的是编辑器总量：访问过的 Tab 保留页面；隐藏时 Office 模型和编辑器被有意保留，Office host 没有接收 `visible`。缓存上限没有约束这些活跃编辑器、iframe 和文档模型的总量。缓存命中仍要在主线程 JSON.parse 完整模型并初始化编辑器，初次保存缓存也有 JSON.stringify。

既有实机记录中，Word 连续 80 次打开后 WebContent 峰值 **3515.53 MiB**，最后一次保持文件后静置约 59.7 秒下降到 **1557.63 MiB**。这是历史二进制的 RSS 轨迹，显示连续操作的内存预算仍未验收；不能把下降归因为特定 GC 行为，或把峰值直接当作泄漏大小。本次没有用历史数据冒充当前提交实测。

Excel 源码 `queueVisualInstall` 在渲染器未挂载或拖拽、图表编辑活动期间每 100 ms 重试，卸载会清理计时器。是否在隐藏页形成持续重试，要结合实际挂载状态观察，暂不列为已复现缺陷。

修复与验收方向：记录可见和隐藏编辑器数量、每个 realm 的存活、关闭 Tab 后的 retained objects、计时器与订阅；确定有未保存内容时的保留规则和可安全冷却预算。对同一打包版本执行连续打开、切版本、切 Project、关 Tab 和关 Workspace，分别检查 CPU 空闲平台、内存回落与长期平台。只在定位对象存活或重复初始化后修改清理逻辑。

## 验证结果

已通过现有 Node 针对性测试 **34/34**：

```sh
node --test \
  packages/dsh-assistant/test/session-inventory.test.mjs \
  packages/dsh-assistant/test/context-session-reads.test.mjs \
  packages/dsh-assistant/test/project-workspace.test.mjs \
  packages/dsh-assistant/test/scheduled-tasks.test.mjs \
  packages/dsh-assistant/test/skills.test.mjs
```

另执行了前述实际函数计数实验及真实 DSH subprocess provider 的退出实验。合成计数说明重复工作规模，不代表真实设备耗时或内存；进程实验使用固定 Node 24.21.0，未操作用户应用。现有功能测试通过不能替代性能预算：例如搜索测试模拟了低成本归属查询，尚未覆盖“真实归属查询内再次列全集”的组合成本。

本次仅增加审计文档，没有修改产品源码、启动应用窗口、执行全量构建或改动并行工作。语音与 Node 路径在 `10382ca..5de9a91` 未变化，34 项检查及计数实验复用到最终审计提交。Windows、真实音频长录制和当前打包 App 的退出闭环仍属于后续验收范围。

## 建议执行顺序

1. 语音回放增量解码与内存预算；语音模型准备和排空移出共享锁。
2. DSH 原生进程树生命周期管理，同时补正常、超时、崩溃和强杀验收。
3. 会话归属索引、冷标题元数据读取与内容搜索分页，消除全集嵌套和逐页重扫。
4. 以 #271 已提交的事件驱动发现为基础，核验宽目录分页、范围脏事件和批量登记的实际 I/O 预算，再复用变更通知驱动目录树。
5. DSH 客户端和 Session 驻留预算、语音渲染隔离、空闲维护唤醒预算。
6. Skills 并发发现合并；GenOffice 用当前打包版本收口连续操作和隐藏编辑器验收。

实施时按上述边界建立独立工作包，保留已有归属校验、音频完整性、任务幂等与未保存编辑内容；不以降低刷新频率代替消除重复工作。
