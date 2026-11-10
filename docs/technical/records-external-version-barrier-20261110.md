# F1：外部 File 固定版本切换保存屏障交付证据

日期：2026-11-10。关联 Issue：#302。本说明仅覆盖 F1，不表示整个 Issue 或原生产品验收完成。

## 用户入口与交付行为

- 用户从 Record 等位置点击同一 File 的固定版本引用时，导航复用已有 File Tab，并更新 `versionNumber` prop。
- `ProjectFileContent` 的外部 prop 请求与版本菜单共用 `requestSelection`：先等待已注册编辑器的 capture/flush/save，确认没有剩余 dirty 内容，再接受版本选择。渲染依据已接受的 `selection`，不会因新 prop 提前卸载编辑器或将其切为只读。
- capture 或保存失败时显示错误，保留原编辑器、草稿和 working session；外部请求通过 `onViewChange` 回写实际保留版本，可在原 Tab 重试。
- 外部请求与菜单共享请求序号。新选择、取消回当前内容和卸载均使旧请求失效；旧成功或失败回调不能覆盖最新选择，也不能回写过期版本。保存本身仍由既有编辑器会话协调。

实现文件：[ProjectFileContent.tsx](../../src/components/document/ProjectFileContent.tsx)。本包未修改 Office 引擎、QuickNote、App、Record hooks 或 HTML parser。

## 原始红绿命令与结果

以下命令均在 `/Users/xuchen/.codex/worktrees/8db5/project_mind` 执行，使用共享 build lock、`maxWorkers=1`。本次文档补录没有重跑测试。

留存 `frontend-probes/file-version.test.tsx` 的错误复现迁入正式 Markdown 测试，并改为正确行为断言。修复前红测命令：

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py node_modules/.bin/vitest run src/components/document/ProjectFileMarkdown.test.tsx -t 'guards an incoming' --maxWorkers=1
```

结果：**2 failed、12 skipped**；两条失败均为预期 `saveText` 调用一次、实际为 0，页面已切到历史只读版本。此前一次收集阶段的包导入失败不计入红测证据。

修复后集中验证命令：

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py node_modules/.bin/vitest run src/components/document/ProjectFileContent.test.tsx src/components/document/ProjectFileMarkdown.test.tsx src/components/document/ProjectFileOffice.test.tsx src/components/document/ProjectFileLoading.test.tsx src/components/document/ProjectFileSessionReference.test.tsx --maxWorkers=1
```

结果：**5 files、139 tests passed**，开始时间 20:26:15，耗时 10.53 秒。覆盖既有 File 加载、关闭、版本和会话引用行为，以及 F1 保存等待、成功、失败重试、并发覆盖、取消、旧失败和卸载。

实际编辑器 capture 验证命令：

```sh
python3 /Users/xuchen/.codex/task-handoffs/project-mind-review-20261110/with-build-lock.py node_modules/.bin/vitest run src/components/document/ProjectFileVersionCapture.test.tsx --maxWorkers=1
```

结果：**1 file、4 tests passed**，开始时间 20:32:30，耗时 3.13 秒。两轮最终验证合计 **6 个文件、143 tests passed**，对应文件如下：

1. [ProjectFileContent.test.tsx](../../src/components/document/ProjectFileContent.test.tsx)
2. [ProjectFileMarkdown.test.tsx](../../src/components/document/ProjectFileMarkdown.test.tsx)
3. [ProjectFileOffice.test.tsx](../../src/components/document/ProjectFileOffice.test.tsx)
4. [ProjectFileLoading.test.tsx](../../src/components/document/ProjectFileLoading.test.tsx)
5. [ProjectFileSessionReference.test.tsx](../../src/components/document/ProjectFileSessionReference.test.tsx)
6. [ProjectFileVersionCapture.test.tsx](../../src/components/document/ProjectFileVersionCapture.test.tsx)

## 实测层级与未覆盖边界

| 路径 | 实际执行层级 | 受控边界与限制 |
| --- | --- | --- |
| Markdown IME，1 条 | 真实 `ProjectFileContent → MarkdownFileContent → MarkdownEditor → CodeMirror`；composition 未结束时不保存、不切换，结束后捕获文本并等待保存回执，原编辑器在等待期间保留 | jsdom 中合成 composition 事件，并通过真实 CodeMirror transaction 输入；native 保存为受控 Promise。不是操作系统输入法或 GUI 验收 |
| Office XLSX，3 条 | 真实 `ProjectFileContent → OfficeFileContent → XlsxEditor → 生产 bundled frame bridge`，执行 `commitEditing` 和 MessagePort 协议；覆盖 capture 等待/失败、保存等待/失败、成功后的会话释放与切换 | **active cell/IME 的 renderer reply 受控**：测试发送 pending/change/reply 数据包，不执行 renderer DOM 中的单元格编辑或 composition。native 保存同样受控 |

Office 测试使用主 checkout 既有生成产物的只读复制，写入本 worktree 的 ignored `dist` 目录；未修改主 checkout、安装依赖或重建引擎。**未覆盖真实 Office renderer DOM、DOCX/PPTX capture bridge 或 native I/O**；不能由本报告推导这些层级已经验收。未启动 GUI，未执行应用全量构建或 Rust 验证。
