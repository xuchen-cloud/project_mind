# Markdown 技术调研 / 最小验证（2026-10-13）

- 关联 Issue：#118；依赖既有 Project File 预览、源码分页和 FileContentService/CAS。
- 固定 GenOffice：`d32d1711f1bf985430757b8c6b3fbddd3831d946`。
- 交付：单独调研文档，公开 core 编辑/导出调用链，现有能力与 CodeMirror 6 的比较，独立 parse/preview/edit/save probe 和机器证据。
- 非目标：主程序接入、UI/GUI 验收、全量构建、富文本无损承诺、review/子 agent、其他 Office 格式重测。
- 验收：原字符与未编辑字节保留有明确策略；GFM/中文/相对图片/引用/HTML 安全分开核对；源码事实与实测分开。
- 写入仅限本目录与 `docs/technical/markdown-integration-candidate-research-20261013.md`。其他路径只读。开始时未发现 tauri dev 进程。
