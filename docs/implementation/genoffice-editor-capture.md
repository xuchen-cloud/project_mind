# GenOffice 编辑器屏幕 / 窗口截图

## 工作包

- Issue：[#191](https://github.com/xuchen-cloud/project_mind/issues/191)，父需求 #118。
- 依赖：Excel 上游 `shared/desktop-api.ts` 的 screen schemas；主负责 lib 注册、runtime/service 和格式 callback 接线、Windows features。
- 范围：`src-tauri/src/editor_capture.rs`、`src-tauri/src/editor_capture/` 与本文。
- 交付：用户点击截图按钮后读取 OS 权限、列出真实屏幕和窗口预览；caller 绑定的短期 opaque ID；用户选中后单次 PNG 原图输出。
- 非目标：录屏、后台定时采集、任意系统句柄 / 路径 / File 权限、上传、格式工具栏重写、可见应用验收、review agents、git、根全量构建或测试。
- 验收：仅 main/project caller；跨 caller / 伪造 / 过期 / 旧列表 ID 拒绝；消失源 null；权限拒绝与原生故障不伪装成功；PNG ≤20 MiB、有限像素；资源随一次操作、选择、过期和 caller 销毁释放。仅编译与无 OS 截图的定向单元测试，真实权限与截图由产品用户动作验收。
- 当前验证：macOS 编译、8 项纯边界测试与 rustfmt 通过；Windows 正式模块首次交叉 check 通过，公共 PNG / thumbnail 修正后待主增量复验。未执行屏幕采集或权限 API。编译由主统一调度，避免低磁盘下重复根 crate 链接。

## 接线合同

```text
desktop_editor_capture_sources(caller: tauri::Webview)
  -> Result<{ status: "ok"|"denied", sources: [{id,name,kind:"screen"|"window",thumbnail}] }, String>

desktop_editor_capture_source(caller: tauri::Webview, input: {id: string})
  -> Result<{mediaType:"image/png",base64:string,width:number,height:number}|null, String>
```

`caller` 由 Tauri 注入，service 仅传 `{input:{id}}`；不接受 renderer caller、原生 display/window ID、系统句柄或路径。`input` 禁止额外字段，id 为 1–256 字节。响应沿用 `packages/office-xlsx/vendor/apps/sheets/src/shared/desktop-api.ts` 的 screen schemas；PNG 20 MiB 的最大 base64 长度为 27,962,028，低于上游 28,000,000 上限。thumbnail 是最长 320×180、保留比例的 PNG data URL，单项编码预算 256 KiB。

主注册上述两个函数到 lib，并接 runtime adapter、desktopApi、OfficeFileContent、Excel 的 `captureScreenSources` / `captureScreenSource`。本包不修改这些文件。模块没有 app startup hook，只有用户触发 command 才会查询权限、枚举或采集；前端不得在挂载或后台轮询时自动调用 sources。

## 授权和选择生命周期

沿用 `dsh_assistant.rs` / `project_directory.rs` 的本地授权边界：

- Webview label 必须为 main 或 project-正整数，且与所属 Window label 相同。远程内嵌 Webview 无法仅靠所属 Window 的 label 获权。
- dev 模式仅允许配置 dev_url 的同 origin；打包模式只接受本地 `tauri://localhost` / `http(s)://tauri.localhost`，拒绝非默认端口及 userinfo。不以 debug_assertions 误判打包 debug 版本为 dev。
- OS I/O 前后重新读取自动注入 Webview 的 URL，阻止权限弹窗或采集期间导航到远程页面后收到桌面内容。

来源在 native 保留；前端仅见随机 128 bit opaque ID。每个 caller 只有最新一份列表，有效 120 秒、最多 64 个来源（屏幕优先），全局最多 32 份。刷新列表立即撤销旧 token；跨 caller、伪造、过期和旧列表 token 都报错，不用 null 掩盖无权请求。选中一个 token 后消费整份列表，即便原生采集失败也不能重用；其他来源立刻释放。

选择列表在超时、caller Destroyed、刷新、一次选择时清理。过期回收在 detached OS worker 内注册，IPC future 被取消也不会漏掉 TTL 回收；旧 generation 的 timer 不会撤销新列表。单个全局 semaphore 允许一个 OS 操作，忙时拒绝而非排无限队列；permit 归 OS worker 所有，IPC 取消不会提前允许第二次采集。等待用户选择时不保持录制 session，不缓存原图、PNG 或磁盘文件。

## macOS

复用现有 `screencapturekit = 10.0.3`、`macos_15_0` features；ScreenshotManager API 需要 macOS 14 或更新。未增加 crate、Swift 项目或录制流。

sources 才可调用 CoreGraphics `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`。用户拒绝时返回 `status:"denied",sources:[]`。capture 只 preflight，不在选择完成后重复弹权限请求；权限撤销报错。ScreenCaptureKit callback 的 crate 封装把部分 NSError 变成文本，本包重新读实际 OS grant 来识别拒绝，不匹配本地化错误字符串。

`SCShareableContent` 列出 display 与普通、在屏幕上的 application window；桌面层、离屏/最小化窗口不提供为本包选择源。窗口保留 SCWindow 身份，选中时根据同 window ID + owning PID 刷新快照，避免沿用用户选择期间改变的几何；来源不再可用返回 null。

每个来源通过明确的 `SCContentFilter` 调用 [SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)，只生成当前用户请求所需的一张预览或原图；不启动 SCStream、音频或麦克风。原图尺寸来自 filter.contentRect × pointPixelScale，保留 Retina 像素；预览直接配置小尺寸。忽略单窗阴影、不包含鼠标。返回 CGImage 在转换 RGBA 之前再次检查尺寸；PNG 在内存中编码，不写路径。SC 对象用 crate 的 retain/release 生命周期管理。

## Windows

仅增加现有 `windows = 0.61.3` 的 features，无新 crate：

```text
Foundation
Graphics_Capture
Graphics_DirectX_Direct3D11
Win32_Graphics_Direct3D
Win32_Graphics_Direct3D11
Win32_Graphics_Dxgi_Common
Win32_Graphics_Dwm
Win32_System_WinRT_Direct3D11
Win32_System_WinRT_Graphics_Capture
```

这些子 feature 自动启用 DirectX、DXGI、WinRT 等父模块。EnumDisplayMonitors、EnumWindows、DWM metadata 只枚举来源；原图通过 [IGraphicsCaptureItemInterop CreateForWindow / CreateForMonitor](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow) 绑定 native source，item 不来自 renderer 输入。排除不可见、最小化、cloaked 和没有标题的窗口。保留 item 的 Closed 事件，之后句柄复用不会重新选择新窗口。

使用 [Windows Graphics Capture 单帧流程](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)：MTA worker、硬件 D3D11 BGRA device、CreateFreeThreaded frame pool、FrameArrived 通知；取一帧后关闭 session / pool / frame 并解除事件。没有 PrintWindow 的同步目标进程调用，也不以屏幕区域裁剪冒充独立窗口。等待首帧上限 5 秒，超时是明确错误；没有 timer 猜测“帧已 ready”。OS 采集边框和保护策略保持默认，不请求 borderless 权限或绕过受保护窗口。Windows 原生拒绝 HRESULT E_ACCESSDENIED 转为权限拒绝，其他错误保留为失败。

检查 GraphicsCaptureSession.IsSupported；Win32 interop 最低 Windows 10 1903，仍需兼容显卡/驱动。不支持时明确报错，不常量返回 denied。CPU staging surface 按实际 ContentSize 和 RowPitch 读回 BGRA，转换 RGBA 后编码；内容变小仅读取有效矩形，内容增大超过初始 buffer 时拒绝并提示重新选择，不能把截断/未初始化像素当截图成功。此实现为 SDR PNG；HDR 色调、受保护内容、远程桌面、混合 DPI 和 OS 隐私策略必须在真实产品动作中验收，不能用编译证明画面正确。

## 预算与错误

- 原图每边 ≤16384 像素、总计 ≤40,000,000 像素，覆盖普通 8K；原始 RGBA ≤160 MB。尺寸检查在 GPU pool / CPU bitmap 分配前以及 OS 返回帧后执行。预算不是进程峰值内存承诺，GPU surface、staging、RGBA 与 base64 有额外副本。
- 输出 PNG ≤20 MiB；Write sink 在编码时限制字节，溢出后保持失败状态，并在 encoder 完全析构后检查该状态。`image 0.25.10` 的 PngEncoder 交给 `png 0.18.1` Writer Drop 写 IEND，后者丢弃终结写入错误，仅相信 encode 返回值会把缺少 IEND 的截断 PNG 当成功；本实现显式捕获此错误。无压缩质量降级、原图静默缩图或 JPEG 冒充 PNG。
- null 仅表示已授权选择的来源消失/不再可用。权限拒绝、无效 token、解码/编码错误、native timeout 和设备故障分别保留失败，不转换为成功或空图。
- source-list 为提供缩略图会按用户此次点击采集预览；完整 PNG 仅在用户选择后输出。原生失败会使来源请求报错，不用空缩略图吞错。

## 验证范围与待验

源码定向测试 `editor_capture` 共 8 项，全部不调用 ScreenCaptureKit、CoreGraphics 权限函数或 Windows capture API：

1. caller label、JSON 额外 caller/path/handle 拒绝；
2. 本地 origin + primary Webview / Window 身份、打包 debug 和 dev origin；
3. 拒绝 / 原生故障 / 消失源的不同结果；
4. caller 绑定、伪造 ID、单次选择消费；
5. 刷新 / 过期 / 关闭撤销、旧 timer 不撤销新列表；
6. 未选来源和过期列表实际 Drop 释放、64 来源预算；
7. 像素和 PNG 字节边界、完整 PNG 像素往返、每个截断预算均拒绝（含部分 IEND）；
8. 横 / 纵 / 方形 / 极窄缩略图保比例和不放大小图、256 KiB 预算、上游 camelCase PNG contract。

主已注册。复用现有 target、统一 debug0 编译及以下定向测试；不启动新 feature variant、不 cargo clean：

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml \
  --config 'profile.test.package.project_mind_alpha.debug=0' --lib editor_capture --quiet
```

2026-10-18 实际证据：

- 主首次 scoped 编译无错误，8 项中 6 通过、2 失败，日志 `/tmp/genoffice-capture-native-tests.log`。随后用 `--lib --quiet -- --exact editor_capture::tests::editor_capture_png_dimensions_and_exact_budget editor_capture::tests::editor_capture_thumbnail_stays_small_and_contract_is_png` 复现同样两项失败，日志 `/tmp/genoffice-capture-two-before.log`。
- 根据本机 image / png 源码定位 IEND Drop 吞错，以及 `imageops::thumbnail` 强制精确尺寸；修正 sink 和尺寸计算，未放宽预算或删除失败断言。相同两项通过，0 失败、1228 filtered、0.09s，日志 `/tmp/genoffice-capture-two-after.log`。
- 上述完整 `editor_capture` 命令：**8 passed、0 failed、1222 filtered，0.07s**，日志 `/tmp/genoffice-capture-native-tests-final.log`。三份 capture Rust 文件 `rustfmt --check --edition 2021` 通过。
- 主统一 `#[path]` 包含正式 capture / print / font 模块，`cargo check --target x86_64-pc-windows-msvc` 首次通过（15.61s）；实际 windows 0.61.3、image 0.25.10，日志 `/tmp/genoffice-windows-capture-check.log`。公共 PNG / thumbnail 修复后增量复验通过（1.98s），日志 `/tmp/genoffice-windows-capture-final-check.log`。只有 scratch crate 的 `cfg(dev)` 声明 warning；不是 app / 安装包链接或 Windows 运行。

当前 capture 源码 SHA-256：

```text
editor_capture.rs          01d9beb7eea877b6faed70ec1ec833c5c99c15689721eec43a0ef23c53eb1403
editor_capture/macos.rs    39c2549b51d1452eed253ef1d8241ede106138b7c8bda838f76a801987a59d42
editor_capture/windows.rs  ba3685f82e5d5267809e54f29ad160222e67dc3ed623661881aaf657cdf54698
```

按用户要求，本包未执行任何截图、权限 API 或录屏。测试复现曾误选普通 app 二进制，发现后立即终止，随后仅用 `cargo test --lib`；该误启动不作为验收。真实待验：macOS 首次授权/拒绝/撤销、Retina/多屏、窗口关闭/移动/缩放；Windows WGC 屏幕/窗口真实首帧、设备支持/权限、内容保护、HDR/混合 DPI、关闭与 timeout 清理；Excel 用户选源后插图的真实接入。本包代码存在或返回 throws 不能作为这些验收通过的证据。
