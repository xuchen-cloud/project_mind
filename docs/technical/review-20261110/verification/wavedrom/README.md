# WaveDrom 移除与集成验证

用户在 2026-11-11 明确要求删除波形图、寄存器图和逻辑图。`6806ad7634dd539e0bcb4a526aa980e9532df929` 已作为 `2b241e5` 集成：删除插入入口、专用渲染、导出分支、21 个语言标签、WaveDrom/JSON5 声明及 25 个专属 lock 节点。旧 `wavedrom` 围栏保持原文，作为普通代码编辑、保存、重开和导出；Mermaid 和数学公式保留。没有采用先前废弃的 renderer-only 方案。

完整实现范围、生成链与最初失败样本见 [工作包记录](../../../../../packages/markdown-editor/WAVEDROM-REMOVAL.md)。原 93 个 upstream 源文件和哈希不变；生成排除规则防止重新引入 renderer/type。主审复核固定 `6806ad` 全部功能增量：Standards **0**、Spec **0**，生成脚本、消费者和依赖移除一致，没有旧内容迁移或丢失。

## 初始检查与实际修正

- 工作包针对性 21 项通过、root 75 个不同相关用例通过。最初 package 全套 70/81 通过，11 个导出/PDF 失败与原基线逐名、逐诊断相同；原始结果保留，未改写成绿测。
- 集成将这 11 个测试的旧“导出与打印”入口更新到实际文件菜单和 menuitem，并在当前默认块编辑器检查文本/打印快捷键。DOCX ZIP/XML、PDF 文件字节、等待实际 IPC 完成、失败/取消、基线改变后的丢弃、无浏览器 fallback 等原有断言完整保留。没有改变产品导出行为或跳过测试。
- 实际 Record worker 首次运行 **5/6** 通过，发现 Rust schema 样本的 `codeBlock` 顺序落后于此前 `44c011c` 将 StarterKit codeBlock 替换为独立 MermaidCodeBlock 的注册顺序。用现有 `scripts/update-record-schema.mjs` 重新生成；仅移动相同的 codeBlock 条目，全部节点定义、marks 和 schemaVersion 相同，projection fixture 按字节不变。Rust 按节点名称查找，未引入文档格式变化；严格 deepEqual 合约断言保留。
- Markdown 撤销竞态独立修复 `9b4fbe2` 已集成为 `4843b50`，见 [诊断和复核](../../../../implementation/markdown-table-undo.md)。最终全套同时覆盖 WaveDrom 移除和真实撤销/重做。

## 最终组合验证

验证源为 `f99ad344a8aa6d88659afc806018e3f9da8f34c9` 加上述两个测试文件及 `src-tauri/src/record_document_schema.json` 的修正。运行期间产品源码未改变；归档和本文是之后的记录。全部重型命令使用共享 `with-build-lock.py`，Node **24.21.0**，静默执行且不启动应用。

| 范围 | 命令主体 | 实际结果 |
| --- | --- | --- |
| 完整 Markdown package | `vitest run --config vitest.config.ts --reporter=verbose`（package cwd） | **82/82**，9 个文件，0 失败 |
| Package 类型 | `tsc --noEmit -p packages/markdown-editor/tsconfig.json` | 0 diagnostics |
| Root 类型 | `tsc --noEmit` | 0 diagnostics |
| 实际 Record worker 和 notices | `node --test packages/agent-host/test/record-worker.test.mjs packages/agent-host/test/record-worker-notices.test.mjs` | **6/6** |
| Rust Record 文档/worker | `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib record_document --quiet -- --include-ignored` | **71/71**，0 ignored，0 compiler warnings |
| 正常 shipping build | `node scripts/office-performance/build-host-graph.mjs` | 通过，**0 eval** 提示 |
| 懒加载与主入口预算 | `node scripts/check-bundle-boundaries.mjs` | 通过，**249 KiB / 250 KiB** |
| Host 构建边界 | `node --test scripts/office-performance/host-bundle-boundary.test.mjs` | **6/6** |
| 锁文件依赖图 | `npm ls --all --package-lock-only --json --ignore-scripts` | exit 0，problems 为空，stderr 为空 |

Cargo 使用 `CARGO_INCREMENTAL=0` 和共享可再生成 target。71 项包含显式启用的 pinned Node 转换/patch、权限限制和已打包资源测试。Record staging 已通过：从源码相同的工作包复制 manifest 列出的 **118** 个 bundle，现有 staging 脚本验证后替换本集成树资源，未修改原 checkout 的源码或 index。

最终 shipping 图共 **274** 个 chunk；WaveDrom、JSON5、bit-field、logidrom、onml、tspan 均未进入图，Mermaid 的 **66** 个 chunk 和 KaTeX 保留。打包仍有已有的 >900 kB 体积提示，未提高阈值或过滤输出。首次主树图构建因缺少忽略的 `scripts/office-performance/output/` 目录失败；创建该输出目录后同命令通过，首个失败日志保留，没有以重复编译代替处理失败。

测试出现的 **15** 条 React/Tiptap `flushSync` 生命周期提示，通过原 `6806ad` 的相同 21 个相关用例复核，其测试名和每项数量完全一致。它们属于已有 jsdom 运行时诊断，未静默，也不计为源码编译或 Vite eval 告警已修复。对比记录见 `runtime-warning-comparison.json`。

主审检查上述最终三文件修正：Standards **0**、Spec **0**；测试继续检验真实契约和导出内容，没有放宽断言。历史失败、最终成功、构建图/lock 摘要和来源 SHA-256 见 `manifest.json`。原 checkout 的 24 个文件和暂存 diff 保持不变。

## 边界

本轮没有新 GUI/native PDF 页面验收，没有 clean npm install 或 Windows 实机测试；真实 native worker 测试不等于 PDF 像素验收。Records/Office 的新用户需求和原生验收仍由对应工作包继续，组合 PR #316 保持草稿，#308 和既定平台 Issues 不因此关闭。这里的 82、71、6 等属于不同层次，不合并为一个产品验收计数。
