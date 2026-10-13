# GenOffice PPTX 外部重开结果

关联 #118 / F03。执行 agent 验证；不是 review，不检查浏览器水印。

## 结果与边界

{"cases": 8, "reopened": 8, "actual_headless_conversions": 6, "reused_original_conversions": 2, "source_unchanged": true, "all_page_counts_equal": true}

只在 `/private/tmp/project-mind-genoffice-pptx-validation-20261013/external` 创建文件；没有修改源 PPTX 或重跑 SDK，没有 GUI、没有新增 PNG。每个候选使用 SHA256 一致的 scratch 输入副本、独立 LibreOffice profile/PDF 输出目录，subprocess timeout=60s。两个原件的输入 SHA256 与先前 Univer 原件记录相同，并且复用 PDF 的 checksum 也核对一致，已复制到本目录并记录 `reuse` 完整来源。候选新 hash 全部实际转换。

**reopened 表示原格式可被独立 LibreOffice 打开并产生 pypdf 可读 PDF，不能直接称保真通过。** Poppler 可抽取中文不证明中文视觉正确；与原件图像像素相同不证明位置相同。当前 headless 中文方框/不可见限制沿用同 hash 原件证据，如实保留；本轮按指示没有更多 PNG。

| 样本/链 | PDF 页数 | 各页图片数 | 业务数量标题 | 转换方式 |
| --- | --- | --- | --- | --- |
| simple / original | 3 | [1, 0, 0] | False | reused-exact-input-hash |
| simple / noop | 3 | [1, 0, 0] | False | actual-headless-conversion |
| simple / edited | 3 | [1, 0, 0] | False | actual-headless-conversion |
| complex / original | 3 | [1, 0, 0] | True | reused-exact-input-hash |
| complex / noop | 3 | [1, 0, 0] | True | actual-headless-conversion |
| complex / edited | 3 | [1, 0, 0] | True | actual-headless-conversion |
| simple / chromium | 3 | [1, 0, 0] | False | actual-headless-conversion |
| simple / webkit | 3 | [1, 0, 0] | False | actual-headless-conversion |

## 内容比较

无改链全文相同（忽略空白）：{"simple": true, "complex": true}。

原件与所有候选的页数、页面尺寸、逐页 Poppler 文本/文字 diff、图片数/尺寸/像素 hash、图表标题 `业务数量` 判断见 results.json。simple 原件没有图表，标题 False 在该样本是“不适用”，不能记成丢失。complex 原件及其候选分别判断；若候选 False，仍记录失败证据，不省略断言。

编辑候选文字本来应不同；本轮只记录外部差异，不将全文相等作为编辑成功条件。图片位置和水印由主 agent 的浏览器验收负责，不重复该任务。

## 失败

[]

没有可重开失败时也不宣称完整 Office 保真；中文视觉、未支持对象和主应用集成仍需各自验收。

## 版本与复跑

使用同 bundled LibreOfficeDev 26.8.0.0.alpha0（前次原件记录附 version），Poppler 26.05.0，pypdf 6.10.0，Python 3.12.14。脚本不引用或安装 node_modules；仅用 Python/pypdf 和系统进程。原件/候选不可覆盖；已有同 source hash 的 successful 结果可复用。

```sh
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 /tmp/project-mind-genoffice-pptx-validation-20261013/external/reopen.py
```

归档脚本也接受 `--scratch <GenOffice样本目录> --univer-evidence <已有原件结果JSON>`；全部输出仍限于该 scratch/external/。

## 收口检查

- 所有 8 件输入当前 SHA256 与记录一致，来源未改；six candidate headless 转换返回 0、无 timeout，两个原件复用来源完整记录。
- 所有原件/候选都是 3 页、同页面尺寸。图片实际绘制次数各页为 [1,0,0]，图片嵌入像素与原件一致。共享 PDF 资源表中图片可能在每页均可列出，未把 resource 存在误记为每页实际画了图片。
- simple/complex 无改文字逐页相同；两份 edited 与 Chromium/WebKit browser 输出的唯一文字差异为第一页“项目进展正常”→“项目进展更新”。
- complex 的原件、noop、edited 的 Poppler 文字均含“业务数量”。这项与 Univer 候选 PDF 中标题缺失的先前证据有区别，但不自动证明所有格式保真。
- 本轮不新增 PNG；中文方框/不可见的 headless 字体限制仍成立，未宣称中文视觉通过。未重复主 agent 浏览器水印检查。
