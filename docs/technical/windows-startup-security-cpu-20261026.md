# Windows 启动后企业安全软件持续高 CPU：只读诊断

关联 Issue [#271](https://github.com/xuchen-cloud/project_mind/issues/271)。日期：2026-10-26。

## 范围与证据状态

- 症状由用户报告：Project Mind 启动后，公司内部安全软件高 CPU **一直持续**；具体产品、进程和驱动未采样确认，不能预设为 Defender。
- 本记录给出代码事实、可证伪假设及 Windows 采样方法。具体修复和回归结果见关联需求。
- 下文源码行号统一冻结在本包开始时的 `10382cad15e9af2fd38db275570ac1fa932485d8`，链接指向该提交，避免与并行修改混用。依赖包例外，明确标为本机安装产物观察。
- 修复后的行为与验证以[按目录变更发现与旧版自动登记需求](../requirements/project-file-discovery-events-20261026.md)为准；下文以旧基线解释问题，不代表 Windows 修复后实测。

## 简明事实清单与因果链

### 1. setup 会恢复工作区并启动多个独立 worker

**事实**：[lib.rs][lib] 1468–1498 先清理旧应用数据、恢复最后工作区，再启动 bridge、source、discovery、overview、scheduled tasks。1499–1512 每秒处理待封存 Record checkpoint；1513–1565 每 250 ms 执行 voice supervisor。不是只有当前页面才工作。

工作区打开经 [workspace_initialization.rs][init] 20–33：打开/绑定 DB → File 恢复、过期上传恢复、Record 操作迁移 → source registry reconcile → 收据压缩 → checkpoint 恢复。这是打开时工作；不能直接解释一直持续。[workspace.rs][workspace] 278–306 还会遍历应用数据目录，对保留名单以外目录递归删除；同样不是定时工作。

**推断**：这些启动活动可能触发企业文件过滤器；是否造成安全进程 CPU，必须通过相同时间窗的栈与路径确认。锁等待本身不等于安全软件扫描。

### 2. 旧 discovery 确实周期遍历；分页不等于只枚举 5 个目录项

**事实（修复前）**：[project_file_maintenance.rs][driver] 16–17、41–105、113–158：活跃 Project 与 Workspace File 轮转；有 cursor 继续分页，否则约 5 秒后重开扫描，worker 忙时睡 250 ms。实际轮次还取决于项目数和 I/O 耗时，不能写成精确每 5 秒扫描整个工作区。

扫描边界是活跃项目根与 Workspace 的 `files/`，不是整个 Workspace 根：[project_directory_files.rs][directory] 1404–1424；[file_scope.rs][scope] 55–61。目录里非隐藏普通子目录会继续进入；没有按扩展名把 `.exe`、`.dll`、`.js` 或普通 `node_modules` 排除：[directory] 136–151、1614–1683。这不代表程序执行它们。

**关键放大**：[directory] 1511–1555 的预算是每页最多处理 5 个待登记文件、消费 128 个候选项；每次建立页内 cache 时，`fs::read_dir` 仍读完整个当前目录，仅保留排序最前的 128 个候选。cache 不跨页保存；宽目录分页会重复枚举其余/已经过的名字。静止大树在旧定时策略下会重复此成本。**不能把 128 解读为底层目录读取次数上限。**

**限定**：[directory] 1685–1689 跳过已登记 `project_directory` 路径，故旧 discovery 对这些文件仍查目录/类型/metadata/SQL，但不是每轮重算全文 hash。首次登记、legacy 或显式 resolve 是另一条路径。

### 3. legacy 旧失败链的主要成本可以早于 checksum

**事实**：[directory] 353–431：`project_file_register` 每个候选先 SELECT 所有非图片 documents，再逐个比较路径；不相同就调用 `path_identity(candidate)`，直到匹配或遍历结束。[file_versions.rs][versions] 198–224 在 Windows 打开文件句柄，再以 `GetFileInformationByHandle` 取物理身份。这是 metadata/句柄访问，不是内容 hash。

旧 legacy 缺身份在 [directory] 762–782 已返回 ambiguous；checksum 位于 791 行，不能把这类失败描述成反复全文 hash。若 n 个候选逐个扫描 n 条 documents，最坏可能有 O(n²) 候选身份探测；实际数量取决于匹配位置、存储模式及已跳过路径，需测量。叠加上一节宽目录反复 `read_dir`，即使文件内容没有被读取，也有持续 I/O 放大来源。

**纠正两处不准确归因**：

- “retain 每轮清空错误”不成立：[driver] 54、62 中 visited 项目每轮更新 round 后被保留。92–99 只保存**整页聚合错误字符串**；不同页的 A/B 字符串交替，会使同一错误再次打印。成功页也没有清空已保存错误。真正问题是去重粒度，不是所有错误都被 retain 删除。
- [directory] 308–351 的 `directory_state` 在 state、reason 都相同时直接返回 projection，不重复 UPDATE/写 change log。不能从重复 stderr 推出重复 DB 状态写入或快照。日志是否被企业软件/外部收集器落盘，也不能仅凭 `eprintln!` 判断。

### 4. 登记会 hash、写快照，并在较大范围内持锁

**事实**：[directory] 433–475 首次预留 File 身份并提交 pending，然后创建版本；532–547 限制单文件 100 MiB，调用 `snapshot_bounded`。[versions] 370–427 按 64 KiB 循环读原文件、写不可变快照、累积 SHA-256、`sync_all`，随后 DB 登记版本。这既有内容读取也有新文件写入。

[source_service.rs][service] 958–964 委托 [record_document_service.rs][record] 1275–1286，同时持有 current_workspace 与 DB mutex；discovery 的目录扫描、身份探测和快照调用在此 closure 内。[committed_changes.rs][committed] 41–43 额外捕获前后 watermark；不是全库内容快照。长文件 I/O 可延长这些 mutex 持有时间，但不能把整个过程称为一直持有 SQLite 写事务：pending 事务已先提交，快照之后另行发布。

### 5. 资源全文 hash 在启动时可能做两遍，但不在空闲循环里重复

**事实**：[source_maintenance.rs][source] 178–203 与 [overview_maintenance.rs][overview] 937–988 各自在循环前调用 `SourceExtractionWorker::for_app`，没有共享该实例的初始化结果。

[source_extraction_worker.rs][extractor] 42–57、95–170：读取清单并完整 hash `agent-host/node.exe`、入口、distribution manifest、notices、全部列出的 bundle/asset（含 PDF cmaps/fonts）。因此正常成功启动时，相同资源集合可完整验证两次，即使还没有选中可处理的 AI scope。循环复用已建实例；初始化失败就退出该 worker，不是每 500 ms 无限重试 hash。

这能解释启动读峰值，**单独不足以解释一直持续的高 CPU**。若稳态仍在读这些资源，应检查短命进程反复导入模块、应用/worker 重启、其他调用链或安全软件自己的扫描；不能先认定这里每轮初始化。

### 6. source 队列可能长时间处理积压；Windows 单次 File 索引存在全文复核放大

**事实**：[source] 82–107、178–203 每轮最多 claim 一个任务，轮后睡 500 ms；按设置、前台忙碌、配额和实际工作选择 scope：[source DB][source-db] 219–285。backfill 是 DB catalogue 分页，每步预算 100；完成且无 reset 时直接返回，不是再次递归文件树：[queue] 109–137。Record/QuickNote 更改合并等待 500 ms（258–266）；普通 Retry 最多 3 次，Yield/新变化另有语义（410–419），不能笼统声称无限失败重试。

[service] 403–418 区分 Record、File、QuickNote、原生对象。Record 仅在缺 canonical baseline 时调用 `record.initialize`（536–558），已有 baseline 不每轮启动转换。[record] 84–89 → [record worker][record-worker] 94–145 → [utility_process.rs][utility] 26–56：每次实际 utility 请求建临时目录并 spawn Node；File 抽取同样每请求启动进程：[extractor] 179–225。队列积压可能形成连续短命 Node，不等于 DSH host 重启。

**Windows 专属事实**：[source_file_snapshot.rs][snapshot] 210–221 读全文/hash；264–269 在 Windows **即使 stamp 未变也再次读全文/hash**。成功 File 索引的调用链为 [source_file_read.rs][file-read] 205 → [service] 460、473 → [file-read] 260 → [service] 492。因此该路径包含初读及两次复核，正常稳定字节也可能读全文三遍；还可能有其他上层校验。本包不建议删掉这些保护，它们承担异步返回后的完整性约束。

**推断**：若 backlog 长期未排空，这条读/进程链可能持续刺激企业安全软件。反证是空队列、无新 change，仍有高 CPU且不出现上述文件读取/Node 活动。空闲时 SQL 轮询不能直接证明有实际磁盘写入，需看 File I/O。

### 7. sherpa / ONNX 不是普通启动必然加载全部模型

**事实**：[lib] 1481 初始化默认 VoiceRuntime；[voice/runtime.rs][voice] 319–426 的 supervisor snapshot 无录音时查 session，恢复未结束录音的轨道，并不调用 `prepare_recognition`。本地识别在开始/继续录音时（135、248、582–588）启动 LocalAsrWorker；[local_asr.rs][asr] 30–56 在线程里建立 recognizer，之后等待工作队列。

[model_package.rs][model] 80–125 校验 marker 中的文件大小、修改时间与预期 hash，相同则跳过全文验证；不能描述成每次 status 都重 hash 模型。启动恢复若有待处理说话人任务则是例外：[lib] 1544–1563 → [diarization_worker.rs][diarization] 25–80 → 模型推理。ONNX/DLL 的 Windows image load 和企业产品的行为检测仍需采样；Rust 未显式创建 recognizer不等于 Windows loader 不加载依赖 DLL。

### 8. DSH host、package 读取、归档和日志应分开判断

**事实**：[dsh_assistant.rs][dsh] 73–125 复用 Workspace 的 Node host，需要启动/身份或目录变化等条件才 launch；1230–1298 检查固定 Node/脚本路径并构造命令，没有对完整 DSH 资源树做运行时 checksum。启动进程在 509–515。scheduled tasks 恢复每 15 秒读取任务 JSON；存在 enabled task 才确保 host：[dsh_schedules.rs][schedules] 67–132。因此“未打开助手就绝不启动 DSH”也不准确。

[runtime.mjs][runtime] 46–72、91–122 每次 host 启动准备 builtin skills、迁移 shared home、解析 profile/package、写配置并 boot。builtin 准备只列资源 skills 顶层并校正链接：[builtin-skills.mjs][builtin] 29–79。迁移可递归复制旧 history，但完成 manifest 会提前返回，目录映射无变化也返回：[migration] 49–76、198–210；不是稳定期定时完整解包。原生会话归档读取也会校验 `session.jsonl` 全文 hash，但由具体读取调用触发：[archive] 205–226。

**依赖产物观察，非 Windows 包证据**：本机 `packages/dsh-assistant/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（`0.2.0-rc.2`）681–718、731–759 按依赖图读取各包 manifest；1253–1300 在模块解析时探测路径/package.json。这是可能的大量小文件访问，不等于递归 hash 全资源。实际 Windows 安装包的版本、插件配置、资源清单须采集比对。`skills.mjs` 81 的 `watch:false` 仅用于该管理调用，不能据此宣布所有运行期 skill provider 都禁用监听。

**构建期与运行期分开**：Node 归档 checksum、`tar -xf` 和 DSH 文件清单校验在 [prepare-runtime.mjs][prepare] 14–37、[stage-dsh-runtime.mjs][stage] 164–235。Tauri 的 beforeDev/beforeBuild 配置调用准备脚本（[tauri.conf.json][config] 7–8）；本次追踪的已安装应用启动链未发现调用这些 staging 脚本。不要把本地构建/安装解包成本直接归给发布应用的稳态。

[dsh] 509–512 将 stderr 丢弃，529–545 消费启动 stdout；不是原生 host 持续写日志文件的证据。Session 持久化、压缩归档、插件日志是否持续发生，需按实际路径和 PID 量测；资源目录有 Node/native 模块也不能推出企业安全软件正在扫描它们。

## Windows 后续只读测量（企业软件 ProcMon / WPR 为主）

不关闭安全软件，不添加排除项，不改工作区数据或安全策略。已有高 CPU 状态优先直接采集；无需为取证反复重启。需要驱动/受保护进程权限时，由公司管理员按内部流程采集；不绕过保护。采集工具仅把诊断产物写到工作区、安装资源与应用数据之外的批准目录。

1. **先固定身份和窗口**：记录应用版本/提交、Windows build、安装或 dev 模式、进程 PID/父 PID/开始时间、安全软件进程与厂商/版本、工作区路径类型（本地/网络/同步盘）、当前是否录音/有 AI 任务。观察 60 秒 CPU 增量及磁盘读写，区分 Project Mind、Node、安全软件、System 的 CPU。不要从累计 CPU 秒数直接判断当前占用。只读保存现有日志中相关时间片，脱敏路径、命令行令牌和正文。
2. **ProcMon 取持续期 30–60 秒**（[官方说明](https://learn.microsoft.com/en-us/sysinternals/downloads/procmon)）：包含 File System、Process/Thread（进程创建/退出、Load Image）；同时保留 Project Mind、其 Node 子进程、安全软件和必要的 System 活动。先留有界原始 PML，再按进程/路径筛选；只过滤应用会漏掉安全产品自己的访问。重点看 QueryDirectory、CreateFile、QueryInformationFile、ReadFile、WriteFile、FlushBuffersFile、进程启动与 DLL/native 模块加载。按 PID+路径统计次数、读取长度、总耗时和每 5/15 秒分桶；统计元数据打开与内容读分开。ProcMon 操作总耗时不是 CPU 样本，ReadFile 字节也不等于物理盘读取量。
3. **WPR/WPA 取同一高 CPU 窗口**：由管理员使用本机已有且获准的配置，采 CPU sampling/调用栈、File I/O、Disk I/O、Process/Thread、Image Load；使用 WPR 界面的 First Level Triage / CPU Usage，并按本机可用项加入文件 I/O；命令行可先用 `wpr -profiles` 查询实际配置。参考 [Microsoft WPR/WPA 排障说明](https://learn.microsoft.com/en-us/troubleshoot/windows-server/support-tools/support-tools-xperf-wpa-wpr)和[命令行选项](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options)。WPA 对安全进程和 System 按 Process → Thread → Stack 汇总；对齐应用文件路径、Node 启动和高 CPU 时间。企业驱动可能运行在应用线程或 System 内，不能只盯安全软件用户进程。缺私有符号或看不到受保护进程时，将模块名、时间窗交管理员/厂商；没有可见 ReadFile 不能排除内核扫描。
4. **只读核对存量状态**：由管理员提供现有 DB 的一致性副本（含必要 WAL），以只读方式查 `agent_jobs` 状态/attempt/not_before、backfill complete、queue cursor、change watermark、legacy storage_mode/身份、voice pending。不给运行 DB 做 checkpoint、修复、迁移或强制 immutable 打开后忽略 WAL。比较采样前后已存在的数据/日志，不以写入测试文件制造事件。
5. **自然启动对照**：若用户之后正常启动，再留一次从启动到静止期的短样本，与已有持续期样本比较；修复后在同一实际 Windows 工作区观察首次扫描结束、无操作静止阶段。不要靠放宽时间到 60 秒继续周期全树扫描。notify 建订阅可能一次枚举目录，需与之后稳态分开；真实文件变更沿用用户正常操作观察。

| 假设（尚未确认） | 应出现的可测信号 | 反证/分流条件 |
| --- | --- | --- |
| 旧 discovery / 宽目录分页 / 身份匹配放大持续触发企业检测 | 项目树重复 QueryDirectory；多个候选伴随大量跨 documents 的 CreateFile/identity metadata；企业 CPU 栈/活动紧随其后 | notify 版本首次完成后仍高 CPU，但项目树无重复枚举/打开，则该解释不足；有枚举无企业 CPU 关联，也不能定责 |
| 新 watcher 或 root 校验制造反馈/周期 I/O | 5 秒整批 root metadata/canonicalize；或只读访问/内部快照事件后反复扫描 | SQLite-only catalogue 的静止期无 root I/O；通知驻留 ReadDirectoryChangesW 的等待本身不算重复遍历。若安全软件活动与扫描互相先后，需栈/驱动证据，不能仅从顺序推导反馈环 |
| source 积压及 Windows 三次全文读取/短命 Node 导致持续成本 | queue 逐步推进，同一任务相关文件多遍读，Node PID 连续产生/退出；资源模块反复加载 | 空队列且无新变化、无 Node/内容读，CPU 仍持续，应转向其他后台路径或企业产品自身 |
| 每次启动资源双重 hash 或模型加载 | 资源集合两组大读取；或 voice-models/ONNX 在有相关语音任务时读入，完成后下降 | 无进程重启/语音任务、资源不再读，稳态仍高 CPU，不能以一次启动 hash/加载解释 |
| DB/快照/日志持续写入触发扫描 | `.sqlite`/WAL/版本快照/session 日志实际 WriteFile/Flush 与对应任务及安全栈关联 | state/reason 不变且没有实际写入时，重复错误文字不足以支持该假设 |
| 企业软件自主扫描/行为策略与上述 I/O 无关 | 应用静止但安全进程或内核驱动持续消耗 CPU，路径/栈指向其自身任务或进程行为规则 | 必须由管理员/厂商数据确认；仅看到安全进程名称和高 CPU 仍不能确认具体规则 |

## 后续候选与收口

- 本次修复覆盖事件唤醒、SQLite-only catalogue、legacy 原路径登记与逐路径错误去重。watch 仅在新增/变更 root 订阅时访问文件系统，并应忽略读事件、隐藏/临时/内部版本路径；以最新需求验收。
- 非阻塞候选：宽目录分页重复 `read_dir`；逐文件全 documents 身份查找的潜在 O(n²)；source/overview 重复资源验证；长期索引积压带来的进程与 Windows 内容复核成本。先由实测排序，再立独立工作包；不可为性能删归属/CAS/完整性校验。
- 本记录基于源码核查；没有在 Windows 上运行应用或采样企业安全软件。
- **缺少 Windows CPU 栈、文件/进程时间线和企业安全产品测量，不能确认具体安全软件归因；也不能宣称主任务修复已解决持续高 CPU。** 最小回传物为：版本/时间窗、PID 树、PML、ETL/WPA 热栈摘要、相关路径访问统计、只读队列状态。

[lib]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/lib.rs#L1468
[init]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/workspace_initialization.rs#L14
[workspace]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/workspace.rs#L278
[driver]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/project_file_maintenance.rs#L41
[directory]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/db/project_directory_files.rs#L353
[scope]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/db/file_scope.rs#L55
[versions]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/db/file_versions.rs#L198
[service]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/source_service.rs#L381
[record]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/record_document_service.rs#L1275
[committed]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/committed_changes.rs#L32
[source]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/source_maintenance.rs#L178
[overview]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/overview_maintenance.rs#L937
[extractor]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/source_extraction_worker.rs#L95
[source-db]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/db/source_maintenance.rs#L219
[queue]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/db/source_index_queue.rs#L109
[record-worker]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/record_document_worker.rs#L94
[utility]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/utility_process.rs#L26
[snapshot]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/source_file_snapshot.rs#L244
[file-read]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/source_file_read.rs#L192
[voice]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/voice/runtime.rs#L319
[asr]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/voice/local_asr.rs#L30
[model]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/voice/model_package.rs#L80
[diarization]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/voice/diarization_worker.rs#L25
[dsh]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/dsh_assistant.rs#L73
[schedules]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/dsh_schedules.rs#L67
[runtime]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/packages/dsh-assistant/scripts/runtime.mjs#L46
[builtin]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/packages/dsh-assistant/scripts/builtin-skills.mjs#L29
[migration]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/packages/dsh-assistant/scripts/shared-runtime-migration.mjs#L49
[archive]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/src/source_session_archive.rs#L205
[prepare]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/packages/agent-host/scripts/prepare-runtime.mjs#L14
[stage]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/scripts/stage-dsh-runtime.mjs#L164
[config]: https://github.com/xuchen-cloud/project_mind/blob/10382cad15e9af2fd38db275570ac1fa932485d8/src-tauri/tauri.conf.json#L7
