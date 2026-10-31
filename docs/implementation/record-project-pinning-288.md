# Record 稳定排序、列表置顶与 Workspace 记录菜单（#288）

日期：2026-10-31。关联 [Issue #288](https://github.com/xuchen-cloud/project_mind/issues/288)。基线 `9ac6ae5e`（develop）。用户已确认右键菜单问题指 Workspace **左侧记录列表**。

## 依赖、交付与非目标

复用既有 Record `updatedAt`、Zustand 持久化、`ActionContextMenu`、`HomeSidebarList` 和 `useKeyedPresence` / 列表位移动画。

交付行为：仅真实修改改变 Record 组内顺序，查看、打开和路由焦点不重排。记录和项目支持置顶 / 取消置顶，置顶项在前，两组内部按修改时间降序、同时间按 ID 降序。置顶按 Workspace 根目录和内容所属范围保存在本机 UI 偏好中，主页、侧栏、焦点导航复用，不写入业务修改时间。Workspace 左侧记录接通右键菜单、重命名和删除，支持取消、无变化、中文输入及失败反馈。

非目标：不改变 Record 正文、原生权限、CAS、版本或 File 标星；不修改会话排序；不增加后端字段或数据库迁移；不承诺跨设备同步本机显示偏好。

## 原因与实现

- Project 侧栏曾优先按访问历史 ID 排名，App 路由和点击都会写访问历史，造成只查看就跳位。移除该排名和全部写入入口；历史本地键不再参与显示。
- Workspace 左侧 Record 已有回调，但没有绑定右键事件。现接通统一菜单；重命名避免 Enter 与 blur 重复提交，Escape、空值和同名不提交，异步失败显示错误。
- `useKeyedPresence` 原先保持已显示项的旧顺序，即便输入顺序改变也不移动。现按传入顺序更新、保留删除项的退出阶段；现有项不重播入场，沿用既有 FLIP 和 reduced-motion 处理。
- `list-pins-store` 以 Workspace / 范围的组合键隔离相同数字 ID；`list-order` 只拷贝排序，不改输入数组。置顶属于显示偏好，切换不会调用业务保存 API。

## 验收与验证范围

以 Zustand 公开动作及重新加载、列表组件用户事件、主页实际菜单、App 导航和已有滚动 primitive 为边界。新增回归先失败后通过，覆盖查看不动、修改后移动、置顶/取消、范围隔离、重启持久化、右键重命名/删除、搜索与标签保留置顶、主列表实际 DOM 顺序。

本包仅改前端与文档，不重跑 Rust 全量或打开应用窗口。复用本机依赖和与基线一致的 Office 生成资源；首次类型检查缺这些资源，复用后仅重跑失败的类型检查，未升级依赖。

| 验证 | 实际结果 |
| --- | --- |
| 13 个受影响 store、排序、presence、侧栏、Workspace/Project 页面与 RecordListItem 测试文件 | 118/118 通过 |
| `npx vitest run src/App.test.tsx --maxWorkers=1` | 56/56 通过 |
| 补回保留的笔记导航既有覆盖后，定向运行 `HomeNoteSidebar.test.tsx` | 4/4 通过；其他源码未变更，复用已通过结果 |
| `npx tsc --noEmit` | 通过 |
| `npx vite build` | 通过；复用未变更的 Office 产物，未重建 Office/native 资源 |
| `npm run check:ui-standards` | 通过 |
| `npm run check:bundle-boundaries` | 通过；主入口 225 KiB / 250 KiB，重型编辑器保持惰性加载 |
| `git diff --check` | 通过 |

全库 `check:portable-paths` 仍报告 24 个既有文件中的 62 条路径文案问题；逐文件与基线内容对比相同，无本包新增或改动的违规文件。新改文档另按同一规则检查，不扩张本包清理历史 Office、CLI 和验收材料。

滚动检查：所有本包改动的有界列表继续使用 `HomeSidebarList`；组件在 children 和尺寸变化后重测遮罩，置顶、筛选、重命名、删除均不新增滚动壳或阻挡层。既有 primitive 的无溢出、双向滚动、短溢出与内容变化测试纳入本包验证。主记录重排复用位移动画，标题左对齐保持不变。

主 agent 自行完成 Standards / Spec 两轴检查，无剩余发现；没有启动 review 子 agent。检查覆盖真实导航入口、同范围 pin 共享、元数据不被查看/置顶写入、菜单回调与错误反馈、排序动画、滚动遮罩和构建分包。全库历史文档路径问题记录为非阻塞后续项；没有为通过检查吞错或降低断言。

## 重命名文本菜单补充验证

基于主修复 `03d95cd9`，补齐左侧记录重命名输入框的原生文本菜单：编辑中直接保留浏览器默认右键行为，普通记录行仍使用记录操作菜单。新回归先复现默认事件被阻止，再将编辑态判断移至 `preventDefault` 之前。工作区侧栏最终 17/17 通过，TypeScript、Vite、UI 规范、分包及 diff 检查重新通过；其他源码未变化，复用前述验证。Standards / Spec 自查无剩余发现。此项不改记录保存、排序或置顶数据。
