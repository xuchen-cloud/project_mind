# Review 工作分派（2026-11-10）

用户已授权恢复执行、新建干净会话及必要 worktree，并在验收后合入 develop。此文件覆盖交接报告的“停工”状态；报告仍保留作为需求/进度快照。

原 checkout 不回退、不重置；24 个源码/测试/配置改动已按 files/office/assistant 三个补丁保存，原件仍在主工作区。各新会话只接管本组补丁。

| key | 会话 | 分组 | 最终集成依赖 |
| --- | --- | --- | --- |
| records | 记录保存与草稿生命周期 · G01 G02 | G01, G02 | 无 |
| native | 原生保存可靠性与录音启动 · G03 G05 | G03, G05 | 无 |
| files | 文件树刷新与文件夹操作 · G07 G08 | G07, G08 | native |
| fileflows | 文件移动、拖拽与版本管理 · G13 G14 G15 | G13, G14, G15 | records, native, files |
| office | Office 渐进打开与缩放 · G04 G09 | G04, G09 | native |
| assistant | AI 会话性能、浮窗与临时文件 · G06 G10 G11 | G06, G10, G11 | 无 |
| mermaid | 记录与 Markdown 图表美化 · G16 | G16 | records |
| integration | 总体验收、文档与 develop 合并 | G12 | 跟踪全部七组；先修观察器，再逐包合并，最终验收 |

分工、补丁与验收要求写在各新会话首条任务中。各组有独立worktree/分支；同文件跨组变更通过依赖后rebase整合。具体线程ID以registry.json为准，各组只写status/<key>.json。合并由integration统一执行，merge前核对exact head、必要验证、Standards/Spec、依赖与目标develop。没有Windows证据不能标成Windows通过。

重型安装/构建/native测试/GUI用with-build-lock.py串行，复用仍有效验证与可再生成缓存，避免6.6GB剩余空间被并发构建耗尽。脚本位于本交接目录，不加入产品实现。
