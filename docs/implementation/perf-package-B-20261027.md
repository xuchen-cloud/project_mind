# 包 B：语音回放与 VoiceRecordPanel

关联：#94、首轮性能审计的回放/渲染/轮询、历史 review R03。基线 `5de9a91`，共享分支 `fix/performance-review-20261027`，主 agent 统一整合、验收和提交。

## 范围与验收

- 指定文件：`src/lib/voice-player.ts` 及测试、`VoiceRecordPanel.tsx` 及测试，新增局部 `VoicePlaybackControls.tsx`。依赖现有 playback manifest、原始分块文件、Tauri asset 协议和 React Query；遵循 ADR-0006/0007/0008。
- 交付：追加 manifest 保持播放/位置/速度；已有窗口不重复读取/解码；有界并发和缓存；长录音窗口 seek、双轨同钟；关闭取消；RAF 与转写隔离；按数据建立 speaker 索引；面板轮询经 Query 去重。
- 非目标：native voice、其他 UI、审计脚本、主执行记录。权限、CAS、幂等、原始轨道和 Transcript 不变。
- 验证 seam 由任务指定：VoicePlayer 公共调用与 Web Audio/fetch 边界、VoiceRecordPanel 用户交互与 voice API 边界。先失败回归再修复；仅执行本包测试，不启动应用或全量测试。
- 修改前未发现 `tauri dev`/Vite watcher；没有创建其他 agent，没有提交/推送。

## 已实现

1. `load` 更新持久化 manifest 时间轴并复用同一播放器；不再为追加块归零、暂停或重建输出设备。AudioBuffer 按路径和原文件偏移标识，缓存窗口内追加不重读旧块。
2. 48 kHz 离线解码，只在用户播放时打开 AudioContext。当前窗口与下一窗口共用一个音频时钟，保留两条原始来源和各自起始延迟、epoch 边界；追加不重排已有 source。
3. 解码/读取槽位最多 2；不同 seek 的窗口串行等待不可取消的 decode 结算。最多 8 个缓存块和 96 MiB AudioBuffer（包含解码中的预留），读到原始声道数后、调用 decode 前再次准入；超预算明确报错。
4. 当前/下一段通常只驻留 4 块。每 250 ms 在播放期间维护窗口，按时间轴前缀最大终点二分定位，完成后调度下一次；暂停/销毁停止维护。大量短 pause epoch 缩短未来窗口以保持容量。
5. 旧版整 epoch WAV 按样本边界划成虚拟 60 秒块。原生实际格式为 44 字节 float32 WAV header；按字节 Range 只读取目标段，保留原始声道。本机 Tauri `src/protocol/asset.rs` 明确单 Range 上限 1000 KiB，因此逐批读取并校验 206 和完整长度，header singleflight 且缓存最多 8 项。不把整轨解码后裁剪。
6. seek 先加载目标窗口再恢复双轨；快速连续 seek 保留播放意图，过期结果不恢复旧位置。销毁中止 fetch、停止 sources、清空缓存；不可取消的 decode 结束后丢弃结果并释放预留，不占用新并发槽。
7. `VoicePlaybackControls` 单独持有 position/playing/speed 和 RAF，面板、转写和 speaker 表单不随每帧更新；来源定位按 navigation identity 应用一次，追加 duration 不再次暂停来源播放。
8. speaker turn 建平衡区间索引；转写分页扁平化和标签按数据 memo。保留重叠多说话人、名称更新、联系人 CAS 冲突后的草稿与重读。
9. 面板原有轮询已全部使用 React Query；保留共享 key，验证慢调用及多个消费者去重。清单初始失败新增明确错误及重试，后台清单刷新和 recovery 错误也显示；读取/解码/预取失败暂停并明确报告，不静默重试。

## 回归与实测预算

以下计数在真实 `VoicePlayer`/React 组件路径上记录，系统边界使用可控 fetch/Web Audio/voice API；不是 CPU、RSS 或真实扬声器测量。

| 场景 | 原实现/失败回归 | 修复后实测 |
|---|---|---|
| 一块追加第二块 | fetch 3 次（重复首块） | fetch/decode 各 2 次；运行位置 3 秒、速度 1.5× 保持，source 共 2 次 |
| 六小时，双轨 720 块 | 首开 fetch 720 次 | 首开 fetch/decode 各 4 次；seek 到 18,015 秒后累计各 8 次；两轨 start 都为 `[10,15]` |
| 一小时双轨连续窗口推进 | 原实现全驻留 | 120 块 fetch/decode/source.start 各 120 次；每步 4 buffers、92,160,000 字节（87.89 MiB），sources 4；销毁定时器 0 |
| 旧版一小时整轨 WAV，seek 3,015 秒 | 96 MiB 准入失败，整轨不可解码 | header 1 次 + 4 个虚拟块 × 12 个 capped Range = fetch 49 次；decode 4 次，全部 Range 请求 |
| 快速 seek，旧 decode 故意阻塞 | 第二次 seek 丢失继续播放 | 同时 decode 峰值 2，最终双轨偏移 15 秒，时钟下一秒位置 2,416 秒 |
| decode 中关闭 | — | fetch 只启动 2 次；完成后 buffer/预留/activeLoads 均 0；面板 unmount 时传入 signal 已 aborted，dispose 1 次 |
| 声道布局超过预算 | — | 调用 decode 0 次即明确拒绝，预留/activeLoads 回到 0 |
| 20 次进度 RAF | 原面板随 position 更新整个树 | 转写 text getter 读取 0 次，进度到 2,000 ms |
| 100 segments × 400 turns | startMs getter 40,000 次，失败回归 | 实测 startMs getter 873 次（定向测量日志 `$TMPDIR/perf-B-counter.log`），预算 <8,000；非逐帧，区间索引依数据变化重建 |
| 两个面板，慢 playback API | — | 首轮合并 1 次；完成后第二轮合并 1 次；再等 5 秒在途仍共 2 次 |
| 未来窗口 fetch 403 | — | 错误回调 1 次，fetch 共 3 次；停止位置推进，5 秒后无新增请求，维护定时器 0 |

## 验证命令与结果

- `npx vitest run src/lib/voice-player.test.ts src/components/voice/VoiceRecordPanel.test.tsx --maxWorkers=1`：初次收口 38/38 通过（VoicePlayer 12，Panel 26）；扩展后的最终验证见下节。
- 逐项 red → green：追加重复读取、六小时首开全量加载、面板追加重建、speaker 全配对、旧整轨窗口、快速 seek 播放意图、清单失败不可见，均先得到对应失败，再修复。
- `npx tsc --noEmit --pretty false`：两次均仅有其他包 `src/components/layout/ProjectSidebar.tsx:1127/1129` 的 `managedPath` 类型报错（`Pick<DocumentVersionRecord, "versionNumber">`）。未修改该文件；本包无诊断。需要主 agent 整合相关类型修改后复验。
- 本包 `git diff --check`：通过；新增控件/记录另作 whitespace 检查。

## 整合限制与剩余验收

- 未启动应用；真实设备长录音、增量录制回听、来源跳转、WebKit/Tauri asset Range 与双轨可听同步，留待主 agent 集中 UI/设备验收。单测不代表实机验收完成。
- 96 MiB 是 AudioBuffer 与其解码预留的硬预算，不声称是浏览器进程总 RSS；还有编码 WAV 窗口、Web Audio 内部存储和原生媒体开销。无法准入的声道/窗口明确失败，没有删轨或静默降级。
- 用户已明确扩大 B 范围，`VoiceFloatingPanel.tsx`/`VoiceCaptionWindow.tsx` 与跨窗口协调已在本包实现、验证，见下节；不再列为待分配任务。
- 不将本包完成视为 #94 整体 Issue 完成，不关闭 Issue。


## 用户扩大范围后的交付：浮窗、字幕窗与真实调用预算

范围已追加 `VoiceFloatingPanel.tsx`/`VoiceCaptionWindow.tsx` 及局部 `voice-live-poll.ts`，不修改 native voice、其它 UI、审计脚本或主执行记录。

- 主窗读取 snapshot/tail，通过 Tauri event 向字幕窗分发。每窗最多一个在途完整读取；强制刷新最多合并一个后续刷新。generation 丢弃关闭、状态操作及主窗发布之前启动的旧回复。
- 录制/暂停且任一消费者可见：完成后 1 秒读取；两窗均隐藏或无录制：主窗完成后 5 秒读取，隐藏消费者不请求 tail。tail 最大 8 条，按各 UI 设置截取；仅录音、折叠字幕不读取无用 tail。
- caption 接管依据主窗公布的**下一周期 + 2 秒宽限**。`read()` 自身也检查 owner deadline。原先“主空闲 5 秒、字幕窗 3 秒抢读”的回归已复现为 20 秒 snapshot 8 次，现为 4 次。录制 lease 3 秒、空闲/隐藏 lease 7 秒，不使用统一 3 秒空闲抢读。
- 主窗正常 stop 发布一次 gone，字幕窗立即接管活动录制；若该通知丢失，按上述 3/7 秒 lease 接管。主窗慢请求只在等待 1 秒后发**一次** busy receipt（30 秒 lease），没有每秒 busy heartbeat；caption 可见兴趣只借活动 state 每 5 秒续约，没有独立 heartbeat timer。无录制期间没有兴趣/busy 心跳。
- 关闭停定时器、取消监听并丢弃在途回复；结束关窗去重。字幕失败仍更新权威录制状态并明确报错；折叠模式也显示可访问的错误图标。重复相同字幕失败只提示一次，成功读取之后再失败才重新提示（red 为两秒 3 次 toast，green 为 1 次）；不清掉仍失败的错误显示。保留现有 CAS revision/requestId、暂停/继续/结束行为。
- 当前 native 没有覆盖 start/pause/resume/end 的状态事件，voice_start 创建 Session 也没有可依赖的全生命周期业务通知；不能以停止轮询假装能被可靠唤醒。已向主 agent 明确说明可由 F 补 native 状态事件；本包已交付的确定预算为合计 5 秒一次空闲补读，不将事件缺失变成无上限心跳。可见性和 UI 操作即时唤醒。

计数在生产调度函数、实际组件路径测量，替换 Tauri event/invoke 物理载体；跨窗口用两个独立 Document，分别固定 visibility，不能将同一个 document 的 getter 当成两个窗口。

| 场景 | 实测 snapshot / tail / 消息 |
|---|---|
| 初始主窗 + caption 发现 | snapshot 3 次（包含发现和兴趣变化），之后进入统一周期；不是每轮重复 3 次 |
| 双窗稳定录制 10 秒 | snapshot 10、tail 10；caption 直接消费主窗包 |
| 主窗隐藏、caption 显示，独立 Document，录制 20 秒 | snapshot 20、tail 20；busy 0、interest 4（依 state 续约） |
| 仅主窗、无 caption 消费者，无录制 20 秒 | snapshot 4、tail 0、跨窗 state/busy 消息 0 |
| 两窗都隐藏，录制 20 秒 | snapshot 4、tail 0；只有 state 4 个，无兴趣/busy心跳 |
| 无录制，主窗显示、caption 显示，20 秒 | snapshot 4、tail 0、state 4；无 3 秒 caption 额外读取 |
| 无录制，主窗隐藏、caption 显示，独立 Document，20 秒 | snapshot 4、tail 0、state 4；同上；真实 Caption UI 首次看到 null 还会关窗 |
| 主窗 snapshot 阻塞 10 秒 | snapshot 1、tail 0；完成后 tail 1；每窗无 overlap，主窗无周期 heartbeat |
| 主窗关闭 | 正常 gone 立即接管；丢失 gone 时录制 2,999 ms / 空闲 6,999 ms 原生读取 0，下一毫秒 1，后续按 1/5 秒读取 |
| stop 后旧回复返回 | onPacket/onError 0，定时器 0，订阅清空 |

追加 Range 数据完整性回归：206 的 Content-Range 起止必须等于请求，total 必须覆盖末字节，body 长度必须完整。原实现错误偏移会成功解码，red 已复现；现在解码 0 次即明确拒绝，加载槽和预留归零。正常 capped Range 仍 fetch 49 / decode 4。

### 最终验证与文件清单

- `npx vitest run src/lib/voice-player.test.ts src/components/voice/VoiceRecordPanel.test.tsx src/components/voice/voice-live-poll.test.ts src/components/voice/VoiceFloatingPanel.test.tsx src/components/voice/VoiceCaptionWindow.test.tsx --maxWorkers=1`：初次整包 77/77 通过（`$TMPDIR/perf-B-final-tests.log`）；其后仅跨窗重复报错与无消费者消息预算改变，对应下条复验，未受影响的 Player/RecordPanel 39 条复用。
- `npx vitest run src/components/voice/voice-live-poll.test.ts src/components/voice/VoiceFloatingPanel.test.tsx src/components/voice/VoiceCaptionWindow.test.tsx --maxWorkers=1`：最终 40/40 通过（14 + 8 + 18，`$TMPDIR/perf-B-live-last.log`）；与上述有效验证合计 **79/79**。
- `npx tsc --noEmit --pretty false`：最终通过，无诊断（`$TMPDIR/perf-B-typecheck-final.log`）；原 ProjectSidebar 的两个整合诊断已消失。
- `git diff --check -- <本包指定文件>`：通过；新增文件另查尾空格与换行。
- 修改/新增：`src/lib/voice-player.ts`、`voice-player.test.ts`；`src/components/voice/VoiceRecordPanel.tsx`、`VoiceRecordPanel.test.tsx`、`VoicePlaybackControls.tsx`、`VoiceFloatingPanel.tsx`、`VoiceFloatingPanel.test.tsx`、`VoiceCaptionWindow.tsx`、`VoiceCaptionWindow.test.tsx`、`voice-live-poll.ts`、`voice-live-poll.test.ts`；本记录。

**真实 Tauri Range 验收尚未完成，不能用 mock/source/doc 判为通过。** 遵守“不启动应用窗口”，未执行 WebKit asset fetch 或真实扬声器检查。主 agent/用户集中实机验收时必须提供真实隐藏 `.project-mind` 录音文件的证据：`voice_playback_get` 授权后 Range `bytes=0-43` 与跨 1000 KiB 边界请求确为 206、Content-Range/body 与请求一致；至少一小时旧整轨 seek 到 3,015 秒只读目标窗口，双原始轨 start/偏移同步，关闭取消读取。若 WebKit 对本地协议/Range 不满足这些条件，本包此路径不能收为实机通过，需要继续修复。本包没有擅自打开应用或把该验收替换成文档。

## 真实 Range / WebKit 集成验收补充

按用户后续明确实现测试授权，新增独立 `src/lib/voice-player.integration/{run.mjs,asset-server.rs,browser.mjs,README.md}`；不进入 Vitest 默认发现，不改播放器稳定源码、不改任何其它包、不启动可见应用窗口。

命令：`node src/lib/voice-player.integration/run.mjs`，**通过**。结果：`output/playwright/voice-range/result.json`；过程日志 `$TMPDIR/perf-B-range-integration.log`。真实浏览器为 headless WebKit **26.5**；原生响应逻辑来自本机 Tauri **2.10.3** 的未修改 `src/protocol/asset.rs`，直接 include 并执行私有 `get_response`，不是 mock 或另写的 Range handler。私有 `safe_block_on` 从同版本原文件逐字提取，依赖严格匹配 Tauri 已编译指纹，无 Cargo 重建或配置/锁文件变更。MockRuntime 只创建真实 Scope 的容器，不创建 Window/Webview。

证据中的 handler SHA-256 为 `662f5e23655488e5a5f2529c8794932d66789db3343c8a4d5a847cedf1be09de`；播放器源码 SHA-256 为 `86a057186a11f574b54e61c9d55723a138c0ad0c71d4ba029502d2f84c4d6ea8`。

- HTTP 载体仅传递请求、响应，实际文件读取、范围解析、状态、Content-Range、1000 KiB 截断和权限均执行 Tauri 原函数/Scope。隐藏 `.project-mind/voice` 原始 WAV 按文件授权，旁边未授权文件实际返回 403。
- 实测 **106** 次 asset handler 调用：206 **100**、403 **1**、416 **1**、普通完整块 200 **4**；所有 Range 响应最大 **1,024,000 bytes**，共读 **94,720,308 bytes**，没有整小时全轨下载。
- 206 中包括 2 次显式 header/cap 探针，播放器旧双轨实际 **98** 次 Range（2 个 header + 8 个虚拟窗口 × 12 批）；首开解码 **4** 块，seek 3015 秒再解码 **4** 块，真实 48 kHz mono AudioBuffer 驻留 **46,080,000 bytes / 4 块**。
- Native OfflineAudioContext 总 decode **12** 次（旧原始轨 8、首次 rolling 2、追加 rolling 2），同时 decode 峰值 **2**；真实 buffer 的 duration/sampleRate/channels 和非零 PCM 样本均有断言。
- 真实 AudioContext play / running seek 有时钟推进；双原始来源同 clock、同 15 秒附近 offset。首个尝试因测试错误地要求真实 AudioContext 时钟完全冻结而失败；改为验证两轨 offset 相等、位于目标附近，且边界按真实起始 offset 计算。没有修改生产调度源码或吞掉真实错误。
- rolling 在 **1.5×** 播放中追加：只新增 **2** 次 decode，不重启旧 source；新增双轨都在 **1.3333333333333335 秒**调度。跨块边界采到 **13** 个真实 AnalyserNode RMS 样本，最小 **0.4309511454**（门槛 >0.005）；之后 seek 继续前进。测量后接真实零增益节点，用户设备不播放测试音。
- dispose 后真实播放器 buffer/source/reservation/activeLoads **全 0**；WebKit 与原生 HTTP helper 已退出，临时 WAV/helper 已删除。

**此项已从“只有 mock/source/doc”升级为真实 WebKit + 实际 Tauri handler 的浏览器路径验收通过。** 仍不能等同完整 Tauri 实机：HTTP 载体没有执行 WKURLSchemeHandler / `asset://` bridge、真实 command IPC/ACL、`voice_playback_get` 授权接线及设备可听同步。必须经真实 Tauri Webview 才能覆盖这些桥接差异；最小统一实机步骤及 DevTools 只读 Range probe 在 integration README，未擅自打开窗口。

## runtime adapter 标准门槛修复与 D 交接

主 agent 标准检查发现新项：`voice-live-poll.ts` 直接导入 Tauri event。已改为复用 `desktopApi.listenEvent`，仅在既有 runtime adapter `src/services/desktopApi.ts` 添加薄 `emitEvent` 转发；保持真实派发错误原样 reject，不改 checker 或协议。

- 新增 `desktopApi` 派发成功/错误传播回归，先得到 `emitEvent is not a function` 的 red，再实现接口。
- 浮窗、字幕窗和双窗调度回归改在 desktop adapter 边界接线。生产轮询策略、generation、singleflight 和预算不变。
- `npx vitest run src/lib/voice-player.test.ts src/components/voice/VoiceRecordPanel.test.tsx src/components/voice/voice-live-poll.test.ts src/components/voice/VoiceFloatingPanel.test.tsx src/components/voice/VoiceCaptionWindow.test.tsx src/services/desktopApi.test.ts --maxWorkers=1`：**119/119** 通过（B 79 + adapter 40），日志 `$TMPDIR/perf-B-runtime-verify.log`。
- `npm run check:ui-standards`：**通过**，日志 `$TMPDIR/perf-B-ui-standards.log`；没有放行规则。
- 指定改动 `git diff --check`：通过。新增独立集成文件不触发默认全量单测，不修改其它包。
- 已在当前任务向主 agent 明确通知，并给出 D 的复验范围：**生产 src 已稳定，可以开始新 Vite build；D 的已通过全量结果按相关源码范围复用，本次仅需上述受影响范围。** 后续仅增补独立测试说明/记录，没有再改生产源码。
