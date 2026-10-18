# GenOffice 原生远程图片粘贴

关联 Word 子 Issue #191、父 #118。2026-10-18：**已实施新 native 模块/tests、Word `onFetchImage` 接线；包构建通过，Chrome155/WebKit26.5各4组真实浏览器粘贴/生命周期回归通过。Native 已冻结，主实际注册编译并执行本模块12/12通过；集中App接入验收仍由主整合。** 此前 PDF/布局/altChunk 证据继续复用。

## 工作包

- 依赖：本地 primary Webview 身份、当前 WorkspaceBinding、现有 GUI File owner/version/hash 服务；现有 reqwest/image/tokio/base64。当前 Cargo.lock 的 reqwest 为0.12.28；本包不改 Cargo/lib/desktopApi/宿主。
- 交付行为：用户粘贴 bitmap-less HTTP(S) 图片时，native 安全读取真实 PNG/JPEG/GIF 原字节，回到仍有效的 Word mount 后由原上游图片插入/保存流程处理。不能仅让浏览器 CORS fetch 成功，不提供通用 HTTP 代理。
- 非目标：任意方法/请求体/调用者自选 header、Cookie/Auth、代理设置、任意文件/路径、图床上传、下载到磁盘、文件管理。已有 bitmap/data 图片粘贴不改；本轮不扩其他编辑器调用方。
- 所有权：本 agent 可新增本文档、`src-tauri/src/editor_remote_image.rs` 及其局部 tests；主负责模块/command/Cargo/TS服务/宿主接线与统一编译。主已完成统一 office 构建并授权本次 Word callback 局部修改。
- 验收边界：真实 native transport 的 DNS→已批准 socket→HTTP redirect/body 与真实 File/binding 校验；再测 Word 用户粘贴→等待/失败→真实 DOCX 保存重开。mock receipt 只能证明调用，不代表下载能力交付。
- 验证限制：不运行 Cargo、根 build/test、可见应用或 Tauri watch；主统一编译并执行下述 native 测试；本 agent不运行 Cargo。

## 已实际读取的固定上游

固定 `genspark-ai/genoffice@d32d1711f1bf985430757b8c6b3fbddd3831d946`。本地505文件缓存含 renderer/shared；原完整临时仓库已不存在，因此用 GitHub contents API 读取该 commit 的 main/electron-utils 原文，没有下载其他版本或大仓库。

| 文件 | 真实职责/本次核实 |
| --- | --- |
| [renderer/App.tsx](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/renderer/App.tsx#L1322) | FileReader bitmap 粘贴优先；无 bitmap 且 HTML 仅图片时，最多10个 URL 顺序调用 `window.desktop.fetchImage`，再用返回 MIME/base64 构造 data URL，交给 `insertImageFromDataUrl`。AI 图片工具也复用该方法 |
| [shared/ipc.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/shared/ipc.ts#L533) | 原方法 `fetchImage(url:string):Promise<{base64:string;mime:string}|null>` |
| [main/docs-main.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/apps/docs/src/main/docs-main.ts#L4001) | `ai:fetch-image` 调 `fetchRemoteImage`、`readBodyCapped(50 MiB)`；Content-Type含png/gif则对应MIME，其余一律当JPEG；异常/null被原实现吞为null |
| [electron-utils/remote-image.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/electron-utils/src/remote-image.ts) | 50 MiB声明长度提前拒绝+实际流计数；UA/图片Accept；Genspark域名加Referer；网络/403/408/429/5xx按500/1500ms重试；`file:`只读取其生成图片存储 |
| [electron-utils/safe-remote-url.ts](https://github.com/genspark-ai/genoffice/blob/d32d1711f1bf985430757b8c6b3fbddd3831d946/packages/electron-utils/src/safe-remote-url.ts) | HTTP(S)、特殊地址/域名拒绝；DNS all addresses 检查；每hop建undici Agent lookup钉选；默认5次redirect（参数归0..10）。DNS的198.18/15 fake-IP有例外；全局proxy存在时不钉选，仅逐hop验证 |

本包依用户最新要求有意收紧：**不接受file/local路径，不允许fake-IP例外或代理跳过钉选，不发Referer，不自动重试，不按响应头猜JPEG，不把下载失败吞成null。** 保留原上游真实图片节点和原格式保存方式。

## 精确公开 API

### Native / desktopApi（建议命名，主负责接线）

```ts
type EditorRemoteImage = {
  mime: 'image/png' | 'image/jpeg' | 'image/gif';
  base64: string;
};
type FetchEditorRemoteImageInput = {
  binding: AgentWorkspaceBinding;
  document: FileBytesInput; // expectedContentHash = "sha256:<64 lowercase hex>"
  url: string;
};

// Tauri: invoke<EditorRemoteImage>('desktop_fetch_editor_remote_image', {input})
desktopApi.fetchEditorRemoteImage(input: FetchEditorRemoteImageInput): Promise<EditorRemoteImage>;
```

Rust receiver使用`tauri::Webview`注入caller，不从JSON接收身份。DTO顶层和所有既有嵌套DTO均`deny_unknown_fields`；不加path、method、headers、proxy、testIP、scopeGrant、caller或任意session权限字段。URL非空且不超过8192字节。成功只返回上述两个字段，PNG/JPEG/GIF原字节不重编码；base64上限为50 MiB原字节的规范base64长度。无`ok:true`替代图片，也不返回最终URL/响应header/磁盘路径。

失败为Tauri `Result<EditorRemoteImage, EditorRemoteImageFailure>` 的reject；建议failure仅`{code,message,httpStatus?}`，message为固定本地文案，不拼接URL、query、Location、reqwest错误正文或远站body。codes：`caller_denied`、`workspace_changed`、`document_changed`、`invalid_url`、`blocked_target`、`dns_failed`、`redirect_limit`、`http_status`、`unsupported_image`、`image_dimensions`、`image_budget`、`timeout`、`busy`。主TS服务将其转成可见错误；不自动重试或转浏览器下载。

### Word callback（已加入公开源码）

```ts
// 同步添加至 DocxEditorProps / EditorOptions；不暴露binding/任意File身份给iframe。
onFetchImage?: (url: string) => Promise<{
  mime: 'image/png' | 'image/jpeg' | 'image/gif';
  base64: string;
}>;

// OfficeFileContent持有实际binding与当前baseline，并捕获到本次调用：
onFetchImage={url => desktopApi.fetchEditorRemoteImage({binding, document: baseline, url})}
```

`EditorOptions`、`DocxEditorProps`、`full-editor.ts` 与 `renderer-host.ts` 已加入此公开回调。有callback就优先await native；没有callback的standalone继续既有HTTP(S) CORS实现。native结构错误/跨realm Error保留原message，失败不隐式降级。主已接desktopApi及OfficeFileContent（宿主绑定与readOnly测试由主记录）。

该callback沿用本轮已验证的mount身份/取消守卫：发起前和await后均须当前mount；与修改有关的fetch在readOnly/saving/history期间拒绝。父宿主捕获当前binding/File baseline，不让旧frame改用新File options。已有`beginOperation/endOperation`覆盖fetch、解码、插入；beforeSave等其完成，失败拒绝保存并显示错误。输出入口的只读例外不适用于粘贴。原件仍由上游buildDocBytes和native File CAS保存，下载命令不写原件。

## 调用授权与 File 归属

### 1. Native caller

- `caller.label() == caller.window().label()`，只接受`main`或规范十进制正数`project-{id}`；拒绝子Webview、打印/截图/助手等临时Webview、前导零label。
- `caller.url()`必须为应用本地URL：release `tauri://localhost`或`http(s)://tauri.localhost`，无userinfo/非默认端口；dev仅当前config.build.dev_url的同origin。label本身不能证明页面可信。
- `project-N`只能处理实际归属于Project N的File；`main`也必须通过当前Workspace和真实owner解析。不能相信输入ObjectRef中的projectId。重用`file_office::gui_request`的server-resolved ownership逻辑和既有ObjectRef/WorkspaceBinding；不从模型或页面输入mint授权。

### 2. 最新可编辑 DOCX File

首个调用方仅Word，本包先要求当前可编辑DOCX File。`document`带固定版本与登记内容hash（沿用FileBytesInput当前真实hash格式，不能将模型snapshot hash擅自转换成另一种格式）。历史版本、归档/删除/隐藏File、未登记外部变化均拒绝。

可复用接缝：

1. `file_office::gui_request(state,binding,internalRequestId,&document.object,true)` 从actual owner生成本地GUI上下文；`true`提供既有`file.update`授权仅用于判断这是可编辑目标，**此服务不执行File写入**。
2. 在短`BoundSourceStore::with_current`闭包中再次校验binding；`file_version_registered_target`校验actual owner/可见性/活跃Project；核对current_version_number；`file_version_gui_metadata(GuiFileVersionPrepare {source_path:None,...server path})`获取冻结metadata与登记hash。该metadata和server path不跨IPC。
3. 释放Workspace/DB锁，使用新模块有实际流预算的hash验证当前原件hash（原`FilesystemFileReader.capture`经核实仅做完整流hash，无大小上限，故此处不调用它）；不能在锁内跨磁盘哈希或网络。按已有File内容预算拒绝超限File，避免借一个超大File放大preflight成本。
4. 哈希后再取短锁重算相同metadata，必须与捕获值相同；native caller仍有效，才开始DNS/HTTP。不能直接复用`source_file_snapshot::FileReadPlan`，它目前仅识别Text/Markdown/HTML/PDF；也不能复用`editor_image_host_document`，后者明确仅Markdown。
5. 每hop DNS完成后、连接前重新核对caller/binding/metadata。所有HTTP/DNS/redirect/body await期间不持有app、DB、File生命周期锁。返回前再次在锁外hash并短锁核对metadata/binding/caller；外部文件变动、版本推进、File归属/可见性变化、关闭重开同Workspace都丢弃图片结果。

有网络错误也执行最后归属检查：旧Workspace/File不能凭失败回执重新进入新上下文。原始Frame当前性由Word父层guard负责；native不会把“输入File仍在DB”误当成“该iframe仍在编辑它”。下载没有CAS提交、DB记录、恢复日志或文件副作用。

## 生产网络规则

1. **只接受绝对HTTP(S) URL。** 拒绝userinfo（含空userinfo）、反斜线/控制字符、缺host、IPv6 zone id、`file/data/blob/ftp`、本机路径。校验原始authority再规范化，避免URL parser先消除空`@`；不能仅用`username.is_empty()`判断。query可保留签名图片URL，不能记录/回显；fragment不参与下载并去掉。
2. 规范化host的小写/IPv6括号/trailing dot。拒绝`localhost`、其子域及`.local/.internal/.localhost`；其他域名解析全部A/AAAA，空集合或任一非公网地址均拒绝。不能只筛掉坏地址然后保留好地址；不允许fake-IP范围例外。
3. **解析与连接绑定。** 每hop保留已批准的地址集合；为该hop建立独立reqwest Client，`resolve_to_addrs(host, approvedSocketAddrs)`绑定已检查结果。URL hostname继续用于Host/SNI/证书校验，不能改成裸IP或允许无效TLS。连接前不重新系统解析；IP literal也按同一IP规则验证。
4. `no_proxy()`禁用环境及系统代理，不复用AI网络/图床客户端；`retry(reqwest::retry::never())`，不重试403/429/5xx或网络失败。`redirect(Policy::none())`、`referer(false)`、`no_gzip/no_brotli/no_zstd/no_deflate`，不启用Cookie store。以上方法已实际核对本机锁定的reqwest0.12.28源码，无需新增crate。
5. 仅GET；固定UA可沿用`Mozilla/5.0`，Accept只广告PNG/JPEG/GIF，Accept-Encoding为identity。无调用者headers、Cookie、Authorization、Proxy-Authorization、Referer、Range；重定向新请求不继承响应Cookie或凭据。响应非identity Content-Encoding明确拒绝，避免压缩后计数语义不清。
6. 手动跟随301/302/303/307/308，最多5次redirect（含初始最多6个GET）；解析相对Location后从规则1重验，重新DNS并钉选。缺/非法Location、未知3xx或超限失败。redirect body不读取到内存，drop关闭；不复制任意header到下一hop。
7. 总deadline从操作入口开始30秒，覆盖preflight等待、DNS、连接/TLS、所有redirect、body与收尾校验；不能每hop重新给30秒。HTTP请求timeout也不得超出剩余时间。初期用单个try-acquire操作slot、busy直接拒绝，不积累无界50 MiB下载队列；该资源slot不是app/DB锁。不可取消的`spawn_blocking`哈希任务持有同一`Arc<OwnedSemaphorePermit>`直至实际IO结束；outer timeout/IPC取消后额度仍占用，但worker仅收尾磁盘IO，不继续网络。
8. 最终响应必须2xx且有支持的真实图片MIME。Content-Length超过50 MiB提前拒绝，但不能仅相信该header：使用Response.chunk逐块累计**实际进入body的字节**，加法先检查剩余预算，超限即drop响应。不先`bytes()/arrayBuffer()`后才检查。redirect/错误body不缓存或回显。
9. Content-Type规范化后仅`image/png|image/jpeg|image/gif`；以实际PNG/JPEG/GIF magic与`image::ImageReader::with_format(...).into_dimensions()`核对一致性、有效头和非零尺寸。拒绝HTML/SVG/WebP/AVIF和错标MIME，不把它们默认为JPEG。尺寸沿用已有native图片基线：单边≤16,384、静态图/动画逻辑画布≤40,000,000像素，乘法用u64；不完整解码/重编码或丢弃GIF原字节。后续浏览器解码失败也必须走粘贴失败回执。

### 公网地址判定依据

实现需覆盖上游全部拒绝范围，包括IPv4-mapped IPv6的底层IPv4；额外拒绝文档/转换/特殊用途地址，不能把`.is_private()`当完整公网判定。DNS和IP literal用同一规则，198.18/15没有上游fake-IP例外。

一般IPv4拒绝0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0.0/24、192.0.2/24、192.88.99/24、192.168/16、198.18/15、198.51.100/24、203.0.113/24、multicast/reserved/broadcast。IPv6先处理mapped地址，再仅允许普通global unicast，并拒绝IETF特殊用途、文档与6to4/地址转换前缀；不为特殊协议地址建立图片下载例外。边界CIDR、mapped、压缩IPv6表示都要有表驱动用例。

该服务采用普通公网图片目标的显式政策；不是把所有“特殊用途但某些可达”的地址当普通CDN。[IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/)与[IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/)于本次2026-10-18核对，页面更新标记均2025-10-09。后续若要扩特殊地址，必须有具体图片调用和对应规则变更，不接受IP例外入参。

## Native 定向用例（主实际12/12通过）

用例先写在新模块局部`cfg(test)`中，主已声明模块并统一编译执行。下表区分规格要求与用例安排，不代表所有输入变体穷尽测试。只有测试build提供loopback server/固定resolver/缩小预算与deadline；生产构造器/DTO不含测试transport、loopback、代理或自选DNS入口。测试不下载真实用户图片、不使用任何账号/远端凭据，不修改全进程代理环境（避免并行测试污染）。

| 边界 | 最小输入/安排 | 必须观测的结果 |
| --- | --- | --- |
| URL/authority/IP拒绝 | file/data/本机path/userinfo/空@/localhost./127/metadata/整数或十六进制loopback/IPv6 mapped loopback/fake-IP；DNS mixed public+private | 失败；不建立socket；URL早期拒绝不调用DNS。合法query中的@不被误当userinfo |
| DNS钉选/无代理旁路 | 测试resolver返回固定public；cfg(test) transport把已批准地址映射到测试server；记录HTTP Host与每hop解析次数，images.test无系统DNS通路 | 每hop只解析一次，真实客户端使用批准集合；生产构造路径无系统/环境代理及TLS绕过 |
| Redirect重新验证 | public测试host→相对public图片；另例public→127/metadata/userinfo；第6次redirect | 相对合法图成功；非法目标在下一socket前拒绝；超过5次redirect拒绝，无redirect错误body缓存 |
| Header/无重试 | 返回一次500；另例Set-Cookie后redirect；记录每次请求 | 每个hop无Cookie/Auth/Referer/Proxy-Authorization/Range；失败只请求一次。固定Accept不广告WebP/AVIF，不发送调用者header |
| 实际body预算/整体deadline | 已测试无Content-Length的chunked流恰好budget和budget+1、跨多个慢redirect；声明长度提前拒绝已实现、未单列变体 | 声明超限先拒绝；实际超过1字节即中断；总耗时服从同一deadline，非逐hop累加；无自动重试 |
| MIME/头/像素 | 本地生成合法PNG/JPEG/GIF；PNG header+HTML；image/jpeg但PNG；SVG；坏/截断头；0/超长/乘积超40M | 合法返回原字节的规范base64与正确MIME；不支持/错标/坏头拒绝；不会把未知内容标JPEG；超像素拒绝且不完整分配RGBA |
| Caller/File/binding I/O后归属 | 非primary/remote页面/Project2领Project3；历史版本；旧generation；延迟响应期间切Workspace、换版本、改原件、归档/隐藏File | 请求前非法不调用transport；请求后归属失效不返回图片base64；准备/网络阶段不写File/DB；延迟期间可并发取Workspace/DB锁证明没有跨网络持锁 |
| Word实际保存（callback层通过；native完整接入待主） | mock宿主回执延迟真实PNG；用户粘贴并立刻保存；结构化native拒绝例；external model/dispose或变只读 | pending可见、beforeSave等fetch+decode+插入；失败拒绝且不产成功快照；旧mount结果不污染新File；DOCX media字节/图片数量保存重开相同 |

## 实施与集中整合分工

1. 本文档作为native receiver与Word callback的具体review材料；不需要引入通用网络配置/代理能力。源规则核实与本地接缝读取已完成。
2. 本agent完成DTO/授权/受限transport与局部tests；主已完成模块声明/command注册及统一Cargo测试12/12。Native结果与Word格式保存结果分别记录，不合并声称已完成全部App验收。
3. 主已提供desktopApi与OfficeFileContent回调，本agent完成Word入口和真实浏览器paste→DOCX保存重开（宿主图片回执为mock，native网络端待主执行）。复用未变化的PDF/布局/其他格式证据。
4. 本包收口需同时有native安全边界实际测试与Word真实格式保存证据；“API存在”“mock返回图片”“浏览器fetch可用”都不等于无CORS native功能已交付。

## 当前实施与验证状态（2026-10-18，本次远程图片工作包）

- 已实施：新`editor_remote_image.rs`及`editor_remote_image/tests.rs`、`tests/document.rs`。真实reqwest手动redirect、DNS public-all与逐hop pin、no_proxy/no retry、50MiB流上限、MIME+头+像素；actual File owner/latest/hash前后核验，网络期间无Workspace/DB锁；100MiB真实File流hash预算与不可取消任务的slot持有。
- Native给主编译入口：`desktop_fetch_editor_remote_image(state, caller, input)`；主仅需module/command注册，现有crate已满足。**本agent未执行Cargo；主全模块12/12通过**；`rustfmt --edition 2021 --check src-tauri/src/editor_remote_image.rs src-tauri/src/editor_remote_image/tests.rs src-tauri/src/editor_remote_image/tests/document.rs`通过。
- Word先写真实用户paste回归，构建前红：命中浏览器URL route并失败 `native failure must never fall back to browser fetch`。证明原版没有调用新宿主回调。不是native downloader成功证据。
- Word已实施：公开onFetchImage、current mount/readOnly前后守卫、native错误原message显示/保存失败、仅无callback才CORS。`src-tauri/resources/agent-host/node packages/office-docx/build.mjs`退出0，505固定上游文件校验通过。
- 已通过：Chrome155.0.8059.80/WebKit26.5各4组：真实paste→pending/save→DOCX media原字节/重开；结构错误原message可见并拒绝保存/不fallback；external replacement/dispose晚回执拒绝且不污染新File；下载中变只读后拒绝插入。`test/output/browser/native-image-final-results.json`汇总两次针对性运行。native回执为mock，仅证明Word接线；不复跑无变化PDF/布局/其他格式。
- Native新增回归包括：真实File71字符hash；网络后generation/版本/归档/原件变化；真实网络期间try_lock可得；流式File超限只读cap+1；等待future超时/取消后slot仍由真实阻塞IO持有，收尾不能进入网络。
- 当前未完成：主集中App宿主最终真实native调用验收；包内native安全边界已实际通过，Word callback/格式保存亦已通过，两者证据分开，不把浏览器mock回执称为native网络端执行。
- 未改：Cargo/lib/db、根依赖与其他格式，未启动可见应用/tauri watch。

### 19:30 native-ready 冻结

Rust模块/tests已冻结；主已注册并完成全模块Cargo测试12/12，2.63秒。本agent未运行Cargo。Word远程图片源码/dist与受影响验收已完成。用户随后要求移除整文件加密UI，仅Word适配层继续改，不阻塞native冻结。

- Word命令：`src-tauri/resources/agent-host/node packages/office-docx/build.mjs`退出0；`DocxEditor.tsx`单文件strict tsc、`full-editor.ts`单文件tsc均通过，参数沿用Word矩阵。
- 浏览器：先运行`test/browser-server.mjs`；设置`OFFICE_PLAYWRIGHT_MODULE`与`OFFICE_ACCEPTANCE_URL`，运行`test/browser-native-image.mjs`。Chrome/WebKit core各3组通过后，新增`OFFICE_IMAGE_CASE=readonly`各1组通过，不重复core。WebKit用`OFFICE_BROWSER=webkit`，无需下载browser。
- Native当前12个test函数（含真实DOCX登记、6种网络后失效、真实文件增长、slot取消两分支）由主实际执行通过，本agent未执行Cargo。真实File流最多读预算+1探测字节；不可取消任务独占slot至IO结束，取消后不能继续网络。
- 当前改动：新native模块及`tests.rs`/`tests/document.rs`；Word `editor-types.ts`、`full-editor.ts`、`renderer-host.ts`、`DocxEditor.tsx`；`test/browser-harness.tsx`、`test/lifecycle-harness.ts`、`test/browser-native-image.mjs`及构建产物；本文、Word矩阵/README。

19:39 Word生产源码/dist亦最终冻结。额外保护UI撤除的`renderer-build.mjs`与`browser-protection.mjs`均已收口，Chrome/WebKit通过；主随后开始集中build，不再并发修改任何生产源码/dist。自有server/构建/浏览器任务已停止。stage需消费最新office-docx/dist，具体SHA见Word矩阵。


### 主线程实际native执行证据

已读取主日志`/tmp/genoffice-native-remote-image-first-20261018.log`尾部：`12 passed; 0 failed; 1230 filtered out; finished in 2.63s`。

```sh
cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --config 'profile.test.package.project_mind_alpha.debug=0' --lib editor_remote_image --quiet
```

以上命令由主执行，包含冻结的slot/有界hash修复；本agent没有运行Cargo或改root/module/Cargo/db。
