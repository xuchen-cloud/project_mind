# GenOffice Word 原生字体度量（#191）

## 工作包

- 依赖：现有 macOS / Windows `font-kit 0.14.3`；主 agent 注册模块、command 和宿主服务。
- 交付：`desktop_editor_font_metrics(family: String) -> Result<Option<FaceVerticalMetrics>, String>`，精确选择已安装 family 的普通字形，返回真实 OpenType 表值。
- 非目标：字体文件路径 IPC、持久缓存、字体安装、前端排版策略、其他 Office 格式、Issue 发布。
- 验收：字段和空值与上游 `packages/font-metrics/src/metrics.ts` 一致；缺失字体不返回替代字体；保留可观测系统错误；默认测试不创建窗口。
- 验证范围：表字节边界、family 规范化与预算、字形排序、序列化、真实本机字体、未知 family；仅运行 `editor_font_metrics` Rust 单元测试。

## 契约与平台

上游基线：`genspark-ai/genoffice` 提交 `d32d1711f1bf985430757b8c6b3fbddd3831d946` 的 `packages/font-metrics/src/metrics.ts` 和 `sfnt.ts`。

- 输入限 1–256 UTF-8 字节；NFKC → Unicode 小写 → 移除 ECMAScript 空白、`-`、`_`，规范化后为空时报错。macOS 通过 [CFStringNormalize](https://developer.apple.com/documentation/corefoundation/1542778-cfstringnormalize)，Windows 通过 [NormalizeString](https://learn.microsoft.com/en-us/windows/win32/api/winnls/nf-winnls-normalizestring) 实现 NFKC，无新增 Cargo 依赖。
- 枚举真实安装字形，逐个读取小型 `name` 表，以 name ID 1/16 的所有语言 family 名作规范化精确匹配。中文/本地化别名与英文名同样有效；不以系统首选 family 名或 `font.family_name()` 缩小范围，不调用 CSS 最佳匹配或通用字体 fallback。
- macOS 使用 CoreText 安装字体描述符与 `CTFontCopyTable`，避开 font-kit CoreTextSource 会整文件读取 TTC 的实现；Windows 使用 `SystemSource::all_fonts` 的路径句柄和 DirectWrite loader 的按表读取。应用层不整文件读取 CJK 字体，不建立磁盘缓存。
- 从 `name` 表的 family/subfamily（name ID 1/16、2/17）复用上游空 wanted tokens 的 styleScore：Regular / Medium / W3 / W4 加分，其他粗体/斜体等样式逐项扣分，相同分数保留系统枚举顺序。
- 从被选中字形的 `head` / `hhea` / `OS/2` 原始表读取整数，不用 `font-kit::metrics`。保持上游 512 字节上限、必需表最短长度、非零 unitsPerEm、OS/2 的独立 64/74/78 字节边界。必需表缺失/损坏返回 `None`；缺 OS/2 仍返回 hhea，typo/win 字段为 `null`。
- 枚举/字形加载失败向 IPC 调用方传播，不吞掉可观测 I/O 错误。CoreText 的 `CTFontCopyTable` 和 font-kit DirectWrite 的 `load_font_table` 在无表数据时仅返回空值，按缺表处理；底层未暴露的错误不能在本模块恢复。
- 序列化严格返回 `unitsPerEm`、`hheaAscender`、`hheaDescender`、`hheaLineGap`、`typoAscender`、`typoDescender`、`typoLineGap`、`winAscent`、`winDescent`、`useTypoMetrics`。无持久缓存、路径输入或可见窗口。

## 验证记录

2026-10-16，本机 macOS，主 agent 已注册模块和 command 后执行：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --config 'profile.test.package.project_mind_alpha.debug=0' --lib editor_font_metrics --quiet
```

- RED：4 个表解析测试在解析实现仍为 `todo!` 时全部失败。
- GREEN：10 passed / 0 failed。包括真实 Arial Regular 表值与全角 family 查询、未知/近似 family 不替代、输入 UTF-8 字节预算、NFKC/小写/空白、普通字形排序、name 表边界、表长度及零 unitsPerEm、USE_TYPO_METRICS、null 与 camelCase 字段。
- 别名修正后再次执行同一模块测试：12 passed / 0 failed，包含合成多语言 family 与本机 `蘋方-簡` ↔ `PingFang SC` 度量完全相同的断言。此前 10 项保持通过。
- 仅对新增模块运行 `rustfmt --edition 2021 src-tauri/src/editor_font_metrics.rs`；未格式化其他文件。Cargo 输出中的现有非本模块 warnings 未在本包扩张修复。
- macOS 的真实安装字体路径已经执行。新增全语言别名回归 RED：保留旧系统首选名过滤时，本机真实 `蘋方-簡` 被拒绝；随后移除此过滤。合成 fixture 同时包含不同语言的 name ID 1、16 和 subfamily 17。
- Windows 使用既有 font-kit DirectWrite loader（已核对 `load_font_table` tag 字节转换、`from_path` 不整文件读取）和 NormalizeString 的平台实现；未运行 Windows 编译或实机测试，待 Windows 环境执行相同测试后才能补验证结论。

2026-10-18 恢复后，使用本轮 `cargo test ... --lib office --quiet` 编译出的同一主库测试产物运行 `editor_font_metrics --quiet`：**12 passed / 0 failed**（0.37 s）。包含真实 Arial 与 PingFang 本地化 alias；未新增 feature 组合、依赖或缓存。此结果仍仅代表 macOS，本包不据此声称 Windows 已实测。

这是 #191 的原生接缝交付记录。前端服务接入、Word 排版验收、Standards / Spec 最终检查与 Issue 发布由主工作包收口。
