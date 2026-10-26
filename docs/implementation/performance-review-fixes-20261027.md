# 性能与历史 Review 修复执行记录

基线：`5de9a91`，2026-10-27。输入为两份 performance-audit 报告及 github-review-followup 报告。用户要求逐项修复，整体通过后提交；本记录随实现更新，不把计划视为交付。

## 统一约束

- 只处理审计中的有效问题，已修复/已失效项保留核对结果，不重复改动。
- 不改变 Workspace/Project 权限、版本/CAS/幂等、原始音轨、崩溃恢复和未保存内容语义。
- 没有运行中的 tauri dev/Vite watcher；编译与测试静默执行。最终集中做必要实机验收，执行前告知用户。
- 原实现阶段主 agent 负责影响分析、接口与方案、整合及 Standards/Spec 自审；6.1 sol 子 agent 负责明确范围的实现/针对性测试。用户随后明确授权两个独立 review 子 agent，审查和整改见下文合并审查记录。
- 子包不提交或推送，不各自运行全量测试；所有修复完成且整体验收通过后统一提交。既有 Issue 只作为范围依赖，不用阶段交付关闭整个功能 Issue。

## 修复包

| 包 | 关联 Issue / 输入 | 交付行为与方案 | 非目标 / 依赖 | 验收和验证范围 |
|---|---|---|---|---|
| A 会话读取 | #105/#249；首轮会话搜索、冷标题、内容分页；E08；R01/R04 | 归属与冷读结果按权威变更失效，合并同一请求/版本重复工作；修复 null 默认值及模型容量比例 | 不放宽范围检查；不改供应商协议 | Node 会话/事件/来源/模型测试，真实 wrapper 调用计数 |
| B 语音回放 UI | #94；首轮回放与渲染；R03 | 分块增量载入、有界解码/驻留，保持位置和播放状态；隔离逐帧 UI 和转写 | 原始双轨不变 | VoicePlayer、VoiceRecordPanel 回归；长录音合成计数 |
| C File 身份与扫描 | #185/#114/#192/#271；R02/R05/R06；目录分页/登记扫描 | 首快照前确认身份；共享导入名校验；确定性失败夹具；削减重复全目录/身份扫描 | 保留外部变化检测、原子替换与恢复 | Rust 对应 File/目录/导入测试；宽目录预算 |
| D UI 契约和导航 | #124/#118；R07/R08/R09/R10；E11、目录树轮询 | 错误传播、活动身份、Todo 查询生命周期、近期版本分页；非幂等分叉不盲目重放 | 不改业务范围；分叉需原生接口时与主 agent 协调 | 对应前端回归，首次请求/失败/重复操作场景 |
| E Office 编辑计算 | #191/#118；E04/E05、隐藏编辑器 | 完整字节生成前合并变更；保存/输出强制 flush；重算与加载重复工作有界 | 保持完整渲染、跨表公式和编辑一致性 | 格式包与宿主保存/输入/生命周期测试；构建/重算计数 |
| F 原生语音生命周期 | #94/#237；共享锁、字幕重复、E09/E10、voice idle | 模型等待与排空不持共享 DB/Workspace 锁；纪要随 Workspace 取消；分离响应取消；空闲维护减频 | 原始轨道优先、转写事实与整场说话人身份保持 | Rust 语音/纪要/恢复测试，取消与并发录制边界 |
| G 原生资源与缓存 | #112/#114/#118/#249；DSH 退出/驻留、E01/E02/E03/E06/E07、Skills/维护 | 子进程树所有权；紧凑 Office 回执；准入在大分配前；锁外 I/O；固定版本读取/抽取复用与失效；后台预算 | 主 agent 负责跨模块接口；不删安全验证 | Rust 资源/Office/Source/Skills；Node 桥接；子进程退出和缓存失效实验 |

## 逐项修复与影响

原实现已提交为 `af8f895`。用户随后要求两个独立子agent双轴审查并合并develop；新发现、整改和最终复核见[合并审查记录](performance-review-merge-20261027.md)。以下链接保留每包的受影响文件、方案、红例、验证命令与测量边界。

| 审计项 | 交付行为与影响 | 证据 |
|---|---|---|
| 语音新增块全历史解码 / R03 | 有界窗口、Range 分块、最多2并发解码；追加保留位置、速度和双轨播放 | [B](perf-package-B-20261027.md)：真实 WebKit + Tauri asset handler，解码峰值2，追加仅2块 |
| 语音全局锁等待 | 独立 voice DB、状态所有权与关闭准入；模型等待和排空不持公共 DB 锁 | [F](perf-package-F-20261027.md) |
| 会话搜索逐项扫全集 | 权威归属索引、事件失效、同次读取共享目录 | [A](perf-package-A-20261027.md)：500事件目录读取500→1 |
| 冷会话串行恢复 | 有界标题/内容缓存，版本变化和权限变化失效 | [A](perf-package-A-20261027.md) |
| DSH 强制退出残留 | native guardian / Windows Job；覆盖普通 detached、PTY、超时、Drop、父进程强杀 | [G1进程](perf-package-G1-process-20261027.md)，跨平台限制见后文 |
| DSH client/session 无限驻留 | idle LRU/TTL；保护运行、挂载、在途RPC、未持久化输入及附件 | [G1驻留](perf-package-G1-20261027.md)，33项定向 |
| 静态文件发现 | 基线已改事件唤醒，本次不重复修复 | 首轮报告及 #271 |
| 宽目录全量枚举/身份扫描 | 保存迭代游标；每页最多128个实际entry；身份索引；FD每scan32/全局128 | [C](perf-package-C-20261027.md)，深/宽目录、错误恢复与句柄释放 |
| 展开目录各自3秒轮询 | 合并脏路径事件，精确刷新受影响分支，隐藏不查询 | [D](perf-package-D-20261027.md)：50分支单变化只刷新1 |
| ASR重复识别增长片段 | 有界实时窗口与重叠、时间预算，终稿优先 | [F](perf-package-F-20261027.md) |
| 回放逐帧重绘/双窗重叠轮询 | 独立进度组件、speaker索引、单所有者单在途查询 | [B](perf-package-B-20261027.md)：双窗空闲20秒snapshot合计4、tail0 |
| 空闲后台维护反复查库 | Notify合并唤醒，空闲30秒校准，耐久任务deadline优先；保留运行节流 | [G2-idle](perf-package-G2-idle-20261027.md)，26通过1忽略 |
| 会话内容每页重新扫描 | 有界内容与附件缓存，版本/权限复核；实际自身JSONL写入不使全集缓存失效 | [A](perf-package-A-20261027.md)：4次实际落盘/500帧全扫8→0 |
| Skills/定时任务获取 | 一个有界可回收发现worker；真实文件指纹、取消/退出；已有host的schedule恢复免重复JSON | [G2](perf-package-G2-20261027.md) |
| 隐藏GenOffice驻留 | 干净预览隐藏释放，恢复滚动/缩放；编辑/未保存/在途操作继续保护 | [D](perf-package-D-20261027.md) |
| E01 Office回执完整模型 | durable回执移除model，旧数据迁移一次；重放按确切提交版本恢复 | [G Office](perf-package-G-office-20261027.md)，3项迁移与head推进重放 |
| E02 排队前大分配 | 源捕获与worker准入均在字节/base64大分配之前 | [G Office](perf-package-G-office-20261027.md) |
| E03 共享锁内I/O/重复字节 | 授权计划锁内建立，读取/哈希锁外执行并复核；元数据校验不重建base64 | [G Office](perf-package-G-office-20261027.md) |
| E04 DOCX构建先于防抖 | 构建前300ms合并，保存/导出强制flush，IME和异步粘贴边界保留 | [E](perf-package-E-20261027.md)：10次输入10→1次构建 |
| E05 XLSX整本初始化重复 | 索引等待退避，相同在途请求合并；不同编辑复用私有固定baseline，容量/空闲/关闭有界 | [E](perf-package-E-20261027.md)：50次不同编辑，open/导入各1次、模型复用49次 |
| E06 连续读页重复读取/解析 | 版本/代次/解析器约束下合并捕获与提取；按实际长度预留配额，增长拒绝 | [G3](perf-package-G3-20261027.md)：真实100请求读/哈希1次、PDF进程1次 |
| E07 搜索命中逐个全量读取 | 保留已验证内容证明，正文逐出后仍复用；变更与权限复核不省略 | [G3](perf-package-G3-20261027.md) |
| E08 AI重复归属/历史 | 与会话索引/内容复用合并；外部冷文件变化与最多5秒漏事件校准 | [A](perf-package-A-20261027.md) |
| E09 分离推理无法取消 | 原生CPU helper持进程所有权，关闭/取消/父SIGKILL清理 | [F](perf-package-F-20261027.md) |
| E10 纪要越过Workspace寿命 | HTTP header/SSE等待取消，worker随Workspace关闭，旧结果不可跨代次提交 | [F](perf-package-F-20261027.md) |
| E11 版本下拉全量/N+1 | 原生近期50项查询；完整历史仍走分页 | [D](perf-package-D-20261027.md) |

历史 GitHub 13条意见的原链接、原级别及复现保留在[历史复核](../technical/github-review-followup-20261027.md)。其中10条有效意见逐项修复如下；另外2条本已修复、1条旧功能移除后失效，不重复修改。

| 历史意见 | 最终处理 |
|---|---|
| R01 #235 null分页默认值 | nullish默认值，保留limit:0；实际RPC/serialized-null组合通过 |
| R02 #189 v0文件身份 | 首次快照失败后仍校验原物理身份；替换须显式确认，不借用已有版本规则 |
| R03 #231追加音频 | 与增量回放合并，播放位置/速度/状态保留 |
| R04 #205输出token比例 | 仍遵守原生上下文四分之一；真实8192目录得到2048 |
| R05 #193权限失败夹具 | 确定性rename失败，移除root/Unix chmod依赖 |
| R06 #186剪贴板隐藏名称 | 与导入共享临时/排除名称规则，避免成功导入后立即隐藏 |
| R07 #181不确定分叉重试 | 一次用户动作分配稳定child identity；原生校验并路由幂等fork，实际丢失响应/重启只有一个child |
| R08 #177路径高亮 | 仅ready文件身份可高亮，ambiguous不可冒充确认结果 |
| R09 #171版本菜单错误 | flush失败拒绝onSelect，保留页面错误和菜单状态 |
| R10 #11取消首次项目查询 | Todo只取消自身相关query；首次Project查询能继续填充；另修复选择后RAF抢回输入焦点 |

## 主 agent 整合检查

- Office通用bytes读取曾被扩展到Office容量，主审恢复文本10MiB/PDF50MiB，并加真实桥接11MiB文本拒绝回归。
- Skills/DSH shutdown返回可回滚lease；后阶段语音退出授权失败或future取消恢复准入，最终commit后才保持关闭。关闭进程允许后续按需重建。
- 新会话文件watcher先测实际JSONL落盘，确认并消除自身flush造成全扫；不是只用内存事件证明缓存有效。
- 目录迭代器补每scan/全局FD预算；深单链可正常分页，宽深嵌套超限明确报错并释放游标。
- 小PDF此前按50MiB上限预留导致真实并发RunBusy；改为实际长度配额并绑定捕获上限，16个小PDF并发与增长拒绝通过。
- Office宿主共享提示和来源导航误归入rich-editor包，导致打开Office连带加载编辑器；调整共享分包后依赖图6项通过。
- 测试运行器分离：Node脚本由`test:tooling`执行，Vitest保留真正Vitest脚本。没有删除失败断言或把产品失败改成跳过。

## 验证记录

- 基线 `5de9a91692136d378fd4595716109bf7c25e4d22`；本地分支 `fix/performance-review-20261027`。
- 固定Node24.21.0：两份审计probe通过；真实计数和API边界结果见上表。
- 前端全量首次249文件：232通过、17失败。13个为Node脚本错误收集，已移到正确runner；其余5个失败断言位于4文件，修复后相关68项与Workspace/Todo111项全部通过。其余已通过且未受影响的检查复用；最终语音adapter相关119项、真正Vitest工具脚本56项通过。没有把这些合并描述成一次全量绿色运行。
- Node tooling全量141项先139通过2失败；许可证路径夹具修正后2/2、实际Office依赖图修正后6/6通过。其余结果复用。
- TypeScript最终`npx tsc --noEmit`通过；Vite最终构建通过；UI标准检查通过；宿主bundle边界6/6通过。
- DOCX全量41/41、PPTX全量21/21；最终XLSX全量101/101；最终Office worker14/14。完整Office资源构建与darwin-arm64 staging通过。
- 真实WebKit26.5 + Tauri2.10.3 asset handler：206/cap/403/416、双轨seek/追加/1.5×、真实音频RMS和dispose通过。HTTP转发仅承载原handler；并非Tauri WKURLSchemeHandler/实际IPC和麦克风实机验收。
- Rust完整`cargo test --lib -- --test-threads=2`：1452通过、4失败、49条件忽略。4失败已定位并修复：分叉fixture缺三段路由；Source测试硬链接改变共享Node ctime。最终失败项及完整Source worker组10/10通过，含新增独立inode回归；生产完整性校验未削弱，其余1452项结果复用。日志 `$TMPDIR/mind-final-rust-full.log`、`$TMPDIR/mind-final-rust-repaired.log`。
- Source真实库定向26通过0失败1原有忽略；补执行4项真实旧Record转换/队列忽略项，4/4通过。打包三格式原生保存/重开/历史和固定Node权限/超时两项显式忽略验收2/2通过。日志 `$TMPDIR/mind-final-source-legacy.log`、`$TMPDIR/mind-final-office-native.log`。
- DSH固定Node全单测226项：225先通过；Skills剩余项是包目录启动时fixture拼错路径，改按import.meta.url定位后Skills组28/28通过。全实际进程集成67项：66先通过；最后定时任务用旧Mind CLI失败，新CLI构建后1/1通过。检查/build:dsh通过；Linux capability分支和macOS进程清理13/13通过。日志 `$TMPDIR/mind-final-dsh-unit.log`、`$TMPDIR/perf-g2-skills-node24-final.log`、`$TMPDIR/mind-final-dsh-integration.log`、`$TMPDIR/mind-final-schedule-cli.log`。
- 最终`CARGO_INCREMENTAL=0 cargo build --manifest-path src-tauri/Cargo.toml --bin project_mind_alpha --bin mind --quiet`通过，没有运行应用。日志 `$TMPDIR/mind-final-native-build.log`。
- 新增文档不包含机器绝对路径。全仓portable-path检查已有54条baseline违规及1条本地忽略upstream文档违规；本次不扩张修改历史文档，也不声明全仓检查通过。

## 验证边界

- 本机macOS；没有声称Windows/Linux原生生命周期实机测试通过。真实硬件录音、可听同步和真实网络模型未执行。
- 常规DSH detached/PTY树与原生退出已实证；工具内部主动创建新SID的daemon不受macOS会话归属覆盖，该边界在进程回归中明确展示。不是任意程序后代的通用操作系统沙箱。
- Office和Source计数降低不等同CPU/RSS/p95百分比；尚未测量的指标不作性能提升数字声明。
- 本次不向GitHub发表评论、不解决线程或关闭父功能Issue；修复与验收按本地代码和本报告收口。

## Standards / Spec 主审结论

由主 agent 直接检查，没有启动review子agent。

- Standards：跨端命令/事件经既有adapter；有界并发、缓存、游标/FD、子进程和错误传播有明确所有者；缓存与失效路径可追踪，退出失败恢复可复用。没有修改vendor/node_modules、放宽资源签名/哈希/权限校验或加入后台轮询补丁。
- Spec：逐项对应首轮15项（含1项基线已修正）、扩展E01–E11及历史R01–R10；保留原始双音轨、不可变File版本、CAS/幂等、真实归属和未保存输入。稳定fork验证不把重试变成再次创建，Office回执重放仍返回原提交版本，Workspace关闭拒绝旧代次结果。
- 整合发现的跨服务退出、目录FD预算、实际JSONL全扫、小PDF配额、Linux systemd退化、Office分包加载及测试隔离问题均已修正并复测。没有遗留本次已确认而未处理的实现阻塞；上文未覆盖平台/硬件及主动daemon边界保持明确。
- 验证按AGENTS要求复用：全量后仅有测试夹具修正，没有再更改生产行为；仅重跑失败项和受影响范围。新文档路径检查、相对链接检查、`git diff --check`在最终提交前执行。
- 原阶段按用户要求先提交本地代码。后续用户已明确授权双子agent审查并合并develop，发布以[合并审查记录](performance-review-merge-20261027.md)为准，只关闭本次整改Issue #273，不关闭跨度更大的父功能Issue。
