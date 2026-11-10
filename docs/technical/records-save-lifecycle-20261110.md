# G01 / G02 Record 保存与草稿生命周期

日期：2026-11-10。关联 [Issue #302](https://github.com/xuchen-cloud/project_mind/issues/302)。

## 实现与所有权

| 议题 | 处理 |
| --- | --- |
| F1 外部固定版本请求 | 与版本菜单共用保存屏障；等待 capture/save 并确认无 dirty 内容后接受选择；失败保留原编辑器，恢复父级版本；序号取消过期请求。详见 [F1 证据](records-external-version-barrier-20261110.md)。 |
| F2 正文与版本错配 | 首次读取、注册和首次 ready commit 之前的本地保存确认均使旧加载失效，重新读取完整 state。首次显示后由既有 saved listener 推进当前编辑基线，不重复覆盖已初始化草稿。 |
| F3 隐藏 QuickNote 错误被吞 | 串行链可继续处理后续操作，但 flush 等待原始 completion 并传播错误。隐藏只读的 QuickNote 仍通过真实 RichEditor 捕获 committed 内容；未完成 composition / 资源操作阻止关闭。 |
| F4 关闭 / LRU 卸载 | Project 关闭与分离使用按工作区及项目筛选的保存屏障。Overview LRU 在异步保存成功前保留原编辑器；失败保留该候选，允许淘汰其他干净候选。 |
| F5 单条保存互相误报 | Workspace Record 的普通保存只 flush 当前 key；窗口退出等全局边界继续 flush 全部记录。 |
| F6 校验错误堵塞 | 只有明确未提交且不可重试的 INVALID_PATCH 可被同 binding、同 base、新 requestId 的修正快照替代。未知结果、CAS 冲突和其他错误继续保留原任务及幂等身份。 |

所有 QuickNote 生命周期保存均在卸载之前完成；unmount cleanup 仅注销，不用异步 cleanup 代替保存。失败时原 editor/session 保持所有权。正常保存仍使用 RichEditor 的 committed projection，未把 AI preview 当作正文。

Project guard、原生分离开窗及其他窗口保存可能等待；这些等待后再次捕获 QuickNote，并在实际关闭动作前同步检查。原生窗口关闭另外持有按窗口计数的 QuickNote 编辑暂停：本窗从 close callback 开始持有到 native shutdown 返回；其他项目窗口在 flush 前持有，成功回执后继续保持，失败/取消时由匹配 requestId 与 requester 的 release 事件恢复。新挂载的 QuickNote 也继承暂停；恢复保留原 editor 与草稿。暂停同时传递只读状态到图片标注等 Portal，标注写入入口检查 editor.isEditable，防止旧回调绕过。

语言回读及排版修复与结果见 [G01 语言及 DOM 契约](g01-html-language-contract-20261110.md)。未改全局字号、行高或段距；修复的是稳定块 ID 初始化触发的多余尾空段。

## 验证记录

所有重型命令由本轮共享 `with-build-lock.py` 串行执行，前端测试 `--maxWorkers=1`。本轮原始证据存放在交接目录 `review/evidence/records-delivery/`，不把 ignored 的运行产物作为产品源码提交。

- F1：六个 File 相关测试文件，143 项通过；测试层级与受控边界见专门说明。
- F2 / F5 / F6：首次实现的 hook、coordinator、persistence、runtime、两类 Focus 页面共 146 项通过。首次 ready commit 的附加竞态先红两条，修复后 hook 与两类 Focus 页面 **122 项 / 3 文件通过**，并验证真实首次 hydration 后再次提交的 document、baseRevision、metadataBase。
- QuickNote：隐藏/快速关闭、串行 session 共 18 项通过；LRU hook / scoped lifecycle / 实际 HomeQuickNote 共 7 项通过。延迟内容 guard / 分离开窗等待后的真实输入回归包含在最终主验证中。
- G01：24 对真实 Chromium DOM fixture，在相同默认/自定义排版、可编辑/只读设置下，正文 computed style、rect、行框、段落/换行/空段数量零差异。42 项 HTML/稳定块回归已有对应通过记录。
- 最终集中前端验证：**21 文件 / 494 项通过**，TypeScript `noEmit`、Vite production build 通过。退出暂停及 Portal 最后补充的回归在旧实现先红 5 条，修复后 **4 文件 / 196 项通过**；随后 `noEmit`、Vite build 和 bundle boundary 检查通过，主入口 **226 KiB / 250 KiB**，重型模块保留懒加载。
- 隔离入口的 macOS debug 原生编译通过；真实 native 运行**未通过验收**，状态及原因见下节。

## 验收边界

单元测试不等于原生退出验收。隔离 native harness 使用全新 `/tmp` 工作区与 app data，真实 SQLite trigger 拒绝项目 QuickNote 更新；须分别检查快速 Project 关闭、隐藏后窗口关闭、六项目 LRU、解除故障重试、最终自然退出和 SQLite 精确正文。

## 原生验收当前状态：待解锁后完成

产品源码冻结于 `c6289d94cd2b512462069c10afbd7e76ee13a570`。四次隔离运行的失败证据均保留：

| 运行 ID | 结果 |
| --- | --- |
| `01s37a52` | App 加载前 Vite 优化依赖触发重载，失败。 |
| `lm8a3g93` | 追加 fflate 优化触发重载，失败。 |
| `quencryk` | 固定 41 个依赖、关闭 discovery/HMR 后，首次界面阶段 180 秒超时；没有足够阶段日志定位，失败。 |
| `6pul1x29` | 已确认真实 App、QuickNote 和 native close listener 就绪，SQLite 故障 trigger 已生效；之后未完成关闭场景，180 秒超时，失败。系统 GUI 检查同时报告 Mac 已锁定、自动解锁失败。 |

失败运行仅终止各自的原生子进程和测试 Vite，不结束用户应用。最后一轮没有原生关闭/恢复成功证据；需用户手动解锁后，在新临时工作区重新完成全部场景。当前 PR 应保持草稿，不标记 ready for merge。动画帧等待改为有界的渲染让步；它不证明实际绘制或视觉稳定，所有通过条件仍须由 DOM、native callback、进程和 SQLite 独立满足。

跨窗口关闭暂停的单元测试执行真实生产 transport 路径，事件及 native 调用受控；本轮没有真实分离窗口联合关闭验收。

本包不声称 Windows 实机或 crash recovery 通过。F1 Office 宿主 bridge 测试也不替代真实 renderer DOM / DOCX / PPTX / native I/O 验收。排版结论限定于已采集 fixture，不推导所有用户历史文档的行距现象均已解决。
