# 项目文件自动纳管与导航布局

关联：[#142](https://github.com/xuchen-cloud/project_mind/issues/142)，承接 [#124](https://github.com/xuchen-cloud/project_mind/issues/124)。本包承接 2026-10-15 用户修正；不代表 #124 的其他平台验收完成。

## 范围

- 依赖现有 Project File 登记、分页目录扫描、文件身份与版本服务、工作区 business change 同步。
- 未归档项目的普通目录递归自动纳管，复制文件或文件夹后无需手动点击纳管。沿用应用内部目录排除、符号链接及特殊文件边界。
- 文件只保留一个集合，提供默认平铺与文件树两种展示；使用一个无文字图标切换，保留可访问名称和提示。
- 搜索和标签只筛选平铺文件；文件树不受共享搜索或标签影响，切换不清空共享条件、不影响记录或会话的筛选。
- 文件树以内联展开/收起目录保留层次，继续使用统一 File 打开路径与滚动边缘遮罩。
- 记录、规划（待办）、文件标题行的新建入口最右；其他图标在其左。文件新建沿用现有导入能力。

非目标：新文件编辑器、Markdown 保存、目录移动/删除、任意符号链接遍历、扩大文件快照预算、完成 #124 所有平台交付。

## 验收与验证范围

1. 后台不依赖当前文件展示或 AI 设置，递归发现普通目录文件；重复扫描不产生重复 File 或无修改版本/业务事件；切换工作区不串写。
2. 展开文件夹，父项与子项同时可见；树中统一打开文件；目录读取失败明确显示且可重试。
3. 已有搜索和标签时仍能切换文件树，树中展示全部目录；返回平铺仍应用原条件。
4. 文件标题行的切换图标在导入加号左侧，记录及规划的新建也位于行末。
5. 先执行受影响组件和 Rust 回归，再集中执行 TypeScript/Vite 构建、UI standards 和 bundle boundaries；复用未变区域验证。保持无窗口验证。Standards / Spec 主 agent 自查。

## 执行证据

### 实现

- 原生驱动随应用启动，扫描当前工作区未归档项目，与当前页面、展示方式和 AI 设置无关。项目间轮转分页，每页最多 5 个新文件、128 个目录项，快照字节预算沿用现有单文件限制；完成后约 5 秒开始下一轮。
- 仅为尚未登记的路径调用现有登记服务；已登记文件不反复读取全文或创建版本，外部内容变化继续在统一打开/resolve 路径核验。归档项目沿用只读边界。
- 本页复用有限目录枚举结果；内部目录、符号链接和特殊文件继续排除。失败项报告原因并继续其他文件/项目，超预算文件保留不可用身份，未伪造首版本。业务变更在释放数据库锁后发布，沿用现有页面刷新链路。
- 文件树使用一个共享滚动视口与原有边缘遮罩；目录展开、收起、外部复制后的重新读取和错误重试均沿用统一 File 导航。目录查询按项目根路径隔离，并加入工作区缓存清理范围。

### 前端验证

均在本工作包前端最终内容或未再修改的相应范围通过；不重复计数重叠的先前运行。

| 范围 | 命令 / 结果 |
| --- | --- |
| 文件树、文件标题工具栏、缓存键 | `vitest run src/components/home/ProjectDirectoryBrowser.test.tsx src/components/layout/ProjectSidebar.test.tsx src/lib/queryKeys.test.ts --maxWorkers=1`：17 项通过；自查调整切换按钮可访问语义后单独重跑文件树 5 项通过 |
| 旧侧栏记录行为 | `vitest run src/components/layout/ProjectSidebar.records.test.tsx`：复用初次三文件验证中的该文件 5 项通过，相关实现未再修改 |
| 规划、会话工具栏 | `vitest run src/components/todo/TodoRail.test.tsx src/components/home/ProjectSidebarSessions.test.tsx --maxWorkers=1`：67 项通过 |
| 项目/笔记侧栏、遮罩、统一内容打开与业务变更刷新 | `vitest run src/components/home/HomeProjectSidebar.test.tsx src/components/home/HomeNoteSidebar.test.tsx src/components/home/HomeSidebarList.test.tsx src/components/project/ProjectContentWorkspace.test.tsx src/components/project/ProjectContentLayoutView.test.tsx src/lib/business-change-sync.test.ts --maxWorkers=1`：65 项通过 |
| 构建 | `npm run build` 通过；最终可访问语义调整后复用未变 Office 构建，`tsc --noEmit`、`vite build` 通过 |
| 门槛 | `npm run check:ui-standards`、`npm run check:bundle-boundaries` 通过；主包 249 / 250 KiB |

### 浏览器验收

使用真实组件、合成项目数据和无窗口 Chromium，未启动应用窗口。1440×1000 与 1000×720 下验收：标题行新建均为 24px 按钮、16px 加号；记录/会话/文件的新建右边缘一致，切换与刷新在加号左边；规划新建是标题行最后可见控件。文件树保留目录与子文件，搜索“不匹配”时仍显示完整树，返回平铺显示无匹配结果，清空后恢复文件。

树列表最大滚动距离 670px 时，顶部/30px/中间/底部/反向滚动的上遮罩透明度分别为 0、0.46875、1、1、逐步回到 0；下遮罩到达底部为 0。收起目录后列表无溢出，两端均为 0，容器尺寸变化后重新测量。截图保存在本机临时验收目录 `/tmp/project-file-layout-check/artifacts/`，不混入产品源码。

浏览器合成环境中的 Tauri AI 事件调用不作为原生验收；既有文件行的版本按钮嵌套产生 React 警告，作为 #124 后续文件行语义整理记录，不扩张本包。

### Rust 与双轴自查

- `CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target cargo test --manifest-path src-tauri/Cargo.toml --lib project_directory_files::tests`：31 通过，1 个既有 ignored 子进程辅助项保持 ignored；覆盖目录纳管、身份/版本、路径边界、超预算、恢复和新增扫描预算/续扫用例。
- 最终统一 UTF-8 游标排序后，针对性 `cargo test --manifest-path src-tauri/Cargo.toml --lib directory_scan_cursor_uses_utf8_order_for_non_bmp_filenames`：1 通过；相关既有结果按未变范围复用。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib project_file_maintenance::tests`：3 通过，覆盖无 AI 设置的跨项目轮转、同工作区重新打开的代际清理、不可访问项目不阻塞其他项目、空闲扫描不写入。上述 Rust 命令复用同一 shared target。
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；仅已有警告。未启动桌面应用，也未将无窗口验证写成 macOS/Windows 实包验收。
- Standards：主 agent 检查本包全量 diff；复用登记服务、归属/身份/版本约束、有限分页预算、既有业务事件发布及滚动组件，无剩余发现。自查中修正了页内重复枚举、UTF-8 游标排序及切换按钮可访问语义。
- Spec：逐项核对 #142 与用户本轮要求，自动纳管、单一文件集合、两种展示、平铺筛选、文件树展开和按钮排序全部覆盖，无剩余发现。没有启动 review 子 agent。

限制：超大单目录仍需每页枚举一次，慢磁盘可能延长同步页的持锁时间；不新增文件监控平台或另一套版本服务。
