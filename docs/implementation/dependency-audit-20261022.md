# 历史与传递依赖复查（2026-10-22）

## 工作包

- 关联：#206，延续已完成的 #201 / PR #205；基线 `7affb23`，无开放阻塞依赖。
- 交付：沿直接导入、动态加载、平台条件、安装图和发布入口确认未用项，清理重复资源与无用声明。
- 非目标：不移除 DSH 官方组件或内部 pi-ai，不削减 GenOffice、Record 导出、语音、截图、剪贴板或历史数据能力。
- 验收：清理项有调用闭包证据，安装图与锁文件一致，针对受影响资源完成真实读取/修改/保存和平台选择验证。

## 已确认的清理

| 项目 | 原因与交付 |
| --- | --- |
| Office 的独立 Node | 原生 Office 复用 `resources/agent-host/node[.exe]`，不再复制同一份 Node 和许可证。版本 guard、隔离参数、固定资源路径保持有效；Node 许可证仍随共享运行时分发。 |
| 原生 Office 中的完整浏览器资源 | `office-runtime/worker.mjs` 仅加载三个 engine 转导入口及顶层 XLSX sidecar。格式 `dist`、上游源码和前端 renderer 保留原样；原生分发只保留实际运行文件及许可证。 |
| DSH node-pty 的异平台预编译文件 | 官方 loader 按 `process.platform-process.arch` 选择目录。只复制发布目标的完整 prebuild，保留官方 JS、源码、ConPTY 辅助 DLL/EXE 和所有许可证。 |
| Word 子包的 `opentype.js` | 源码及四个构建入口均无导入；原生字体度量和实际字体资源保留。PPT 自身仍使用 opentype.js，不能跨子包一并删除。 |
| 根 `@types/katex` 直接声明 | 当前 KaTeX 自带类型；删除重复声明。`micromark-extension-math` 仍依赖该包，因此不计安装树或包体收益。 |

原生 Office 分发从 377 个文件收敛为 13 个运行/许可文件，另有一份分发清单。组装入口检查 engine 的构建闭包，发现新增外部模块或运行资产需求时停止，避免遗漏资源。前端仍通过 `office-renderer-resources.mjs` 从各格式 `dist` 打包完整编辑器、字体与导出资源。

## 实测资源变化

macOS ARM64，同一组已构建格式资产，以文件逻辑字节计算：

| 资源 | 清理前 | 清理后 | 减少 |
| --- | ---: | ---: | ---: |
| Office（含独立 Node） | 318,810,791 B | 19,662,755 B | 299,148,036 B |
| DSH | 224,181,027 B | 199,964,682 B | 24,216,345 B |
| 合计 | 542,991,818 B | 219,627,437 B | **323,364,381 B / 308.38 MiB** |

其中共享 Node 和许可证约 116.62 MiB，原生 Office 浏览器资源/重复 sidecar 约 168.67 MiB，DSH 异平台终端文件及对应清单约 23.09 MiB。未计入上一轮 Pi/LibreOffice 清理收益。

Word 清洁安装后移除一个实际 npm 节点（锁文件 148 → 147），重建的 64 个 `dist` 文件与移除前逐字节相同。根 KaTeX 类型声明清理的安装树收益为零。

## 应保留的依赖

- 根 128 项生产依赖中，其余项均有应用、DSH vendored UI、GenOffice、worker 或构建脚本调用。不能只搜索 `src` 判定未用。
- Mermaid、Shiki、Lexical、CodeMirror、Tiptap、DSH remotes、simple-icons、pdfjs-dist 均有动态加载或编辑/预览用途。
- 根 docx/pdfkit 仍用于 Record 导出，GenOffice 接入未替代该路径。
- Univer OSS presets、Fluent icons、RxJS、IronCalc 用于完整 Excel renderer 和计算；Word 的 PDF/图像库、PPT 的 Konva/字体库及 Markdown 导出依赖均有实际用途。
- 历史 validation 环境不在正常生产安装/构建链；部分 fixtures 仍被性能或真实验收脚本引用，不能整目录删除，也不把它们算入生产体积收益。
- Rust 直接依赖均有业务、测试或平台调用。图片剪贴板会启用 arboard 的 image-data/macOS TIFF；Windows 音频 API 受 StructuredStorage/Variant feature 控制；macOS 麦克风捕获需要 screencapturekit 的对应能力。不能按无显式类型引用删除。

## 需要上游改动的传递链

已记录为独立工作包 #207，未计入本轮减少量：

1. `sherpa-onnx-sys@1.13.8` 为仅 iOS 使用的 ZIP 分支无条件编译 ZIP 默认算法链。桌面实际解包 tar.bz2，可在上游按目标平台隔离；仍需验证首次归档解包、缓存命中和本地识别。
2. `candle-core@0.11.0` 无条件依赖 tokenizer；当前 FSMN VAD 未使用 quantized tokenizer。需同时为依赖和模块提供可选开关，再做真实语音样本回归。

根 `default-features=false` 无法撤销上游已启用的 Cargo feature。本轮未为此引入第三方库分叉。双版本 reqwest 分别服务业务调用和 updater，也不能视为未用包直接删除。

## 验证与范围

- 修改前确认没有 `tauri dev` 自动重启进程；验证未打开应用窗口。
- DSH staging 测试覆盖 macOS x64/arm64、Windows x64、Linux x64，确认目标资源完整、异平台目录退出分发、缺失目标失败且保留此前有效资源。
- 从全新生产目录安装 DSH 466 个包并生成完整资源/许可证清单；使用共享 Node 24.21.0 执行裁剪后的真实 PTY，成功输出并退出。
- Office 常规原生测试及打包资源的三格式读取、编辑、保存、重开和 XLSX 计算验证以最终组装产物为准。
- 根类型检查覆盖最终类型声明变化。额外执行的独立 Markdown typecheck 有 32 条既有错误；临时恢复基线根 manifest 后再次运行，诊断逐字节相同。该命令会收集编辑器测试的 `exact` 参数与 rich-editor `toggleHighlight` 类型错误，不属于本次依赖变化。
- 根 npm 锁文件节点仍为 760；删除 KaTeX 类型声明不改变安装图。

### 验证命令

| 命令/检查 | 结果 |
| --- | --- |
| `node --test scripts/stage-dsh-runtime.test.mjs` | 17 通过；含目标选择、完整 ConPTY 资源、清单和许可证校验 |
| `node --test scripts/office-distribution.test.mjs` | 14 通过；含缺少开发工具时导入、闭包变化、Windows 目标和真实 worker sidecar 路由 |
| `node --test scripts/desktop-runtime.test.mjs packages/agent-host/test/office-worker.test.mjs` | 13 通过 |
| `npm --prefix packages/office-docx ci --ignore-scripts --no-audit --no-fund`；`npm --prefix packages/office-docx run build` | 通过；505 份锁定上游文件校验通过，64 个产物不变 |
| `npm --prefix packages/office-docx test` | 24 通过；1 项因缺少 XLSX 开发缓存失败，恢复锁定安装后仅重跑该项通过，共 25 项通过 |
| `node scripts/office-distribution.mjs aarch64-apple-darwin`；`node scripts/stage-office-runtime.mjs darwin-arm64` | 真实组装与 staging 通过；13 项运行/许可资产及清单 |
| `node packages/office-runtime/verify-packaged.mjs` | 三格式隔离 worker 编辑/重开、Excel renderer gateway 保存通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib office --quiet -- --test-threads=1` | 25 通过、4 个显式 opt-in 用例跳过；含共享 Node 路径与缺失资源检查 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib office_real_formats_native_save_reopen_and_retained_history --quiet -- --ignored --test-threads=1` | 最终精简资源下 1 通过；三格式原生保存、版本历史、重开及 Excel 计算 |
| `npx tsc --noEmit`；`npx vite build`；`npm run check:bundle-boundaries` | 通过；主入口 249/250 KiB；完整前端 renderer 仍独立分发 |

原生测试使用规范化临时目录，保持现有 SQLite no-follow 约束。未更改 Rust 依赖/feature，未重跑无关语音或整仓测试。

### Standards / Spec 自检

- Standards：检查了锁文件、构建工具安装顺序、engine 闭包、目标平台文件名、可执行位、共享 Node 路径、许可证及资源验证失败时保留先前有效分发的行为；无剩余发现。
- Spec：DSH 官方组件/内部 pi-ai 和全部 GenOffice 格式 `dist` 保留；只移除重复发布资源和未用依赖。真实 worker、原生保存及前端生产构建均通过；无剩余发现。
- 由主 agent 完成双轴检查，未启动 review 子 agent。独立 Markdown typecheck 的既有诊断已与基线对照，不作为本次通过项。

体积按未压缩资源的逻辑字节统计，不等同于最终压缩安装包收益，也不代表编译耗时实测。
