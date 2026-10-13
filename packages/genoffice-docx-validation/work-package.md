# #118 / F03 GenOffice DOCX 实际对比（执行）

- 依赖：GenOffice 固定 d32d1711f1bf985430757b8c6b3fbddd3831d946 公共源码；同受控 simple/complex fixture、fixtures.json；独占本目录 npm 依赖。
- 交付：真实 parseDocx → 无编辑 save；段落/表格单元格编辑 save；如编辑需 Tiptap 回转则运行原公共转换；真实 engine 重开 + 独立 python-docx/ZIP 语义核对；可复跑归档与可供主 agent 浏览器接入的原型 API。
- 非目标：主 root / docs / 原件变更、完整 Electron、GUI / LO、全仓 build/tests、子 agent、review、ee 或许可绕过。
- 验收：原文（仅目标替换）、表格、图片字节/位置、格式、分节/页眉页脚、分页、超链接、页面参数、作者/Company；记录全部损失与异常，文件存在不算通过。
- 验证范围：两个 fixture 的 engine/noop、engine/edit、公共 GUI 转换/noop、公共 GUI 转换/edit，原 Tiptap schema/EditorState 的 noop/edit，共 10 组；真实 engine 重开和独立 20 项语义断言。主 agent 完成两浏览器 × 两样本的真实键盘编辑，4 候选另归档。浏览器视觉与交互由主 agent 验收，公开 core 预览水印/品牌仅调查源码和运行依赖路径。
- 协议：genoffice-docx-controlled-roundtrip-v1；每条结果保留 protocol_id、model_path、baseline_hash 和 strictchanges。fixtures.json 原样保存，其本身缺少统一 protocol id，本包显式声明并绑定其 SHA256。

- 收口复用：主 agent LO 10 records reopened / 8 comparisons 全通过，外部证据以 external-reference.json 绑定。精简归档保留锁与脚本，移除本目录可重建的 upstream/build/node_modules/models；不重复转换。
