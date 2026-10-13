# #118 PDF 候选选型扩展

- 依赖：GenOffice 固定 SHA `d32d1711f1bf985430757b8c6b3fbddd3831d946` 的公开源码；Mozilla PDF.js 官方源码/API；pdf-lib 官方源码/API；仓库现有 PDF 只读组件；bundled Python/Node。
- 交付：网络核验的候选报告；真实 PDF 表单保存/重开最小试验；清晰分开预览、标注/表单与原正文修改；主程序和 DSH 使用同一 File ID、固定版本/hash 和 CAS 保存方案。
- 非目标：review、feature 实现、源码/其他报告改动、应用窗口、全量构建、Office 外部检查、完整 GenOffice PDF 原文编辑验收、绕过文档/运行时限制。
- 写入范围：本新目录及 `docs/technical/pdf-integration-candidate-research-20261013.md`。
- 验收：两份受控 PDF 原件保留；用 pdf.js `annotationStorage`/`saveDocument()` 与 pdf-lib 表单 API 修改并另存；pypdf 独立读取字段、checkbox、未改页面/内容/链接/图片；失败照实记录。覆盖文字另做原文仍可抽取的受控反例，不能称无损原文编辑。
- 验证范围：仅候选运行和独立重开，不重跑应用测试。GenOffice 本轮仅源码调查；GUI、WebView 与业务保存均未交付。
- research 技能的后台 agent 指引：当前会话未提供可调用子 agent 工具，因此执行 agent 自行完成一级来源核验，不创建用户聊天来替代子 agent。
