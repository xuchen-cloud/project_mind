# GenOffice PPTX 技术验证（2026-10-13）

路径约定：`$VALIDATION_TMP_ROOT` 为原验证产物的临时根目录。复跑前按环境设置；历史临时产物不随仓库提供。


- 关联：#118 / F03；本包为技术验证，不是 review 或 Issue 交付。
- 上游：genspark-ai/genoffice，固定 SHA `d32d1711f1bf985430757b8c6b3fbddd3831d946`。
- 依赖：既有 simple / complex PPTX 样本与独立 Python 检查器；公开 Apache-2.0 core。
- 交付：实际 parse → no-op save / 中文编辑 + 图片平移 → save → SDK reopen；独立 python-pptx/lxml/openpyxl 语义、notes/chart/master/layout 检查；可运行 browser RenderTree bootstrap 和机器结果。
- 硬要求：预览/编辑无水印；不加载 ee，不删除或绕过 license 检查。
- 非目标：产品接入、GUI/LibreOffice 验收、复杂格式缺陷修复、review、发布/合并；不启动子 agent。
- 验收：simple 基础修改准确且其他内容保留、原件 SHA 不变；公开渲染闭包无需 license key/水印；复杂样本如失败保留真实证据。
- 写入范围：独占 `$VALIDATION_TMP_ROOT/project-mind-genoffice-pptx-validation-20261013` 与本目录。其他源码只读。开始时未发现 tauri dev 自动重启进程。
- 验证范围：只测所选引擎/渲染 package 与试验 harness；不运行根项目构建/测试。GUI 由主任务统一验收。归档前通知用户。
