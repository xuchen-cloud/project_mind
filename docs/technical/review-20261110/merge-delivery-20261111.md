# 2026-11-11 合并交付记录

用户的新明确指令是先把本批全部现有改动合入并推送远端 `develop`，再由指定的新 GPT-6 Astra 会话使用 full-review 做整体审查；不再等待之前未完成的 Windows、性能或界面验收。本次合并遵循这一顺序，既有失败和未执行项保留原状，不改写为通过，也不绕过 GitHub 的实际强制要求。

## 纳入的最终提交

| 工作包 | 最终提交 | PR |
| --- | --- | --- |
| Records G01/G02 | `8f6005601c4cbe2c6b5a603c274aceef56a408f8` | #314 |
| Native G03/G05 | `04506b4951c5941e14664ffaaa1aee8dcb694976` | #310，先前已合并 |
| 文件导航 G07/G08 | `3ef75dab445b72af4cea796c22289403f8a28029` | #312 |
| 文件流程 G13/G14/G15 | `cf8a8e0e075d44b2133c88a5090c77e44dfa9b37` | #316 集成交付 |
| Office G04/G09 | `91d3d904dc6dd84278239f2aef979e69a3bef355` | #313 |
| Assistant G06/G10/G11 | `c81bb16621e3147d51a93c431e41ae69d2137e83` | #311 |
| Mermaid G16 | `7890691a2dd8dfd83282d83255460a005e971760` | #309 |
| G12 既有观察器 | `53d5369c28c031f2d739492637f1ed1491039ea3` | #315，先前已合并 |

接收指令时七组工作区均无未提交改动，远端 `develop` 为 `32d91471fda05ebb4028bac1e223eb02c4184e75`，PR #309–#314 中除 #310 外均未合并；#316 仍为草稿。未发现正在执行的其他 merge/rebase/push。Office 在 `a79d558` 后还有 G12 观察器吸收提交及 Round5 证据，因此使用更新的 `91d3d90`，未遗漏这两个后续提交。

`16ee617` 纳入已发布 develop 历史，未改变内容。`c71d57e` 合并 Records，`9f5918b` 合并 Office。File-flow 七个提交已全部是主集成历史中的精确 patch 等价项（`git cherry` 全部为 `-`）；`1e6005b` 仅补充其父提交关系，内容零变化。至此上述七组最终 head 均为集成 HEAD 的祖先。

辅助分支清单也已核对：授权、Markdown undo、native acceptance、Record move、warning cleanup 和 WaveDrom 分支的独立补丁均已纳入或是精确等价项。File move 的 `078ba7e` 对应已集成 `2fea91a`：核心新增文件及实现相同，差异只在同时集成的 schema/Record move/元数据适配。其两个重复编译修复（`88a9d59`、`3784984`）已有统一的 `file_recovery_error` 和 `OperationUndoBatchOutcome` 导入；不会重放旧的冲突替代方案。观察器 `6919ba7` 的入口和回归与最终 Office/集成源码相同，文档额外保留了主审记录。

## 冲突处理与限定检查

- Records extension 同时保留 `MermaidCodeBlock` 与 `PreviewTrailingNode`，StarterKit 对应默认项仍关闭，`TextCaret` 接入保留；Markdown 已修复的 layout-effect 历史同步未回退。
- 原生拖入同时保留 Records 的窗口级监听生命周期、错误提示，以及 File-flow 的 CSS 坐标、悬停目标、当前 callback、去重和异步完成隔离。组件卸载移除 subscriber，不释放窗口级 native listener；测试据此检查组件不再收到事件，同时 native 监听保持。
- 初次冲突检查 172/173 通过；一条旧测试仍假定重新启用组件会注册第二个 native listener。更新为真实的同一窗口 pending registration fixture，保留较新拖拽坐标不被清空的断言，并增加单次监听及错误提示断言。最终 hook 全套 **27/27**，其他两文件 **146** 个通过结果复用，共 **173** 个不同用例。没有删除或跳过用例。
- Office 保留 G12 的 renderer/binding 身份校验、可重新触发的 metadata query，与 Office 的 archive version/hash 证明合并；仅 working source 在证明失效时发布 null，不清除其他历史文件引用。`ProjectFileContent` + `ProjectFileOffice` **147/147** 通过，包括 pending/missing/mismatch/no-change 四种 source 发布情况。
- observer 两个 add/add 冲突仅是已有主审文档和末尾空行；保留所有证据、主审记录及规范 EOF。运行时入口与 canvas proof 未产生新行为。
- root `tsc --noEmit` 在两组集成后通过，0 diagnostics；受影响源码 `git diff --check` 通过。检查使用共享构建锁与 Node 24.21.0，没有启动 GUI，也没有重新等待既有平台或性能门槛。

以上是处理新合并冲突的限定检查，不是用户指定的合并后独立整体审查。原始日志及 SHA-256 见 `verification/merge-20261111/`。

## 保留的问题与审查输入

- Office Round5 XLSX 仍 **6/7**：B3 数值、格式与主画布合成通过，但模式切换中三帧缺少绘制证明；iframe/画布一直存在，原因未判定为产品闪屏或观察器误报。
- 同轮 XLSX 冷开 **1764 ms**，之前 DOCX **1193 ms**、PPTX **1133 ms**，均超过 1000 ms；属于 embedded-debug 单样本，不是 release/p95 或全启动达标。
- Windows 10/11 + WebView2 实机、Assistant 高对比度、文件拖拽缩放/占用/junction/系统回收站等仍缺环境或实机证据；既有平台 Issues 保留。
- 跨窗口 GUI、真实第二卷及部分 OS 拖拽验收边界仍按对应证据记录。此前 Mac 单窗口通过不扩大为这些范围通过。
- WaveDrom 已移除，旧围栏保留普通代码；Rust/TS 编译告警清理记录有效，Vite 大块体积提示和已有 jsdom React/Tiptap 生命周期提示未掩盖。
- Records 最终工作包报告了其新增真实保存与排版验收通过；本次仅复用该准确提交的原有证据，没有重新宣称本次执行了这些 GUI 场景。

原 checkout `/Users/xuchen/project_mind` 的 24 个源文件和暂存 diff 保持不变；共享 Rust target 是可再生成产物。无强推、reset、删除用户数据或删除工作分支。本记录不包含尚未发生的远端合并 SHA；实际最终 develop SHA 和各 PR 状态由合并后 API/远端 Git readback 确认，并记录到 G12 交付状态。
