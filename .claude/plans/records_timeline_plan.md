# 项目记录时间线与侧栏调整实施计划

## 目标
将项目记录从按 Activity/标签分组改为扁平时间线，移除记录类型文案，优化侧栏体验。

## 关键发现

### 现有数据结构
1. **后端 (Rust)**:
   - `ProjectOverviewData` 包含 `record_groups: Vec<ProjectRecordGroup>`
   - `ProjectRecordGroup` 结构: `{ group_key, group_title, notes: Vec<NoteRecord> }`
   - `fetch_project_record_groups()` 调用 `fetch_project_notes()` 然后按首个标签分组
   - `fetch_project_notes()` 已存在，按 `created_at DESC` 排序
   - `NoteRecord` 包含 `noteType` 字段

2. **前端 (TypeScript)**:
   - `ProjectOverviewData` 接口定义了 `recordGroups?: ProjectRecordGroup[]`
   - `ProjectOverviewPage` 通过 `overview.recordGroups` 渲染分组卡片
   - `ProjectSidebar` 接收 `records: ProjectSidebarRecordItem[]` 数组
   - `RecordRow` 组件展示 `recordTypeLabel` 作为副标题

### 当前渲染逻辑
- 项目页面遍历 `recordGroups`，为每个分组渲染一个 `SurfaceCard`
- 分组卡片头部显示 `groupTitle` 和记录数量
- 每条记录在阅读态显示: 标题或类型名称、类型副标题、正文、底部标签
- 侧栏显示记录列表，点击后使用 `focus=record-{id}` 参数

## 实施步骤

### 第一步：后端 API 调整 ✓
**文件**: `src-tauri/src/models.rs`, `src-tauri/src/db.rs`

1. 在 `ProjectOverviewData` 添加 `records: Vec<NoteRecord>` 字段
2. 在 `project_get_overview()` 中调用现有的 `fetch_project_notes()` 填充 `records` 字段
3. 保留 `record_groups` 字段兼容前端（值设为空向量）

**实现**: 利用现有 `fetch_project_notes()` 方法，它已经按 `created_at DESC` 排序

### 第二步：前端类型更新 ✓
**文件**: `src/lib/types.ts`

1. 更新 `ProjectOverviewData` 接口，添加 `records?: NoteRecord[]`
2. 保持 `recordGroups` 字段用于过渡

### 第三步：项目概览页重构 ✓
**文件**: `src/components/project/ProjectOverviewPage.tsx`

1. 修改数据获取逻辑: 从 `overview.records` 而非 `overview.recordGroups` 获取记录
2. 添加搜索和标签筛选 UI 到"记录"区域头部
3. 实现前端搜索逻辑: 匹配标题、正文、标签
4. 实现前端标签筛选逻辑: 与搜索叠加生效
5. 移除分组卡片，改为扁平时间线渲染（每条记录独立 `SurfaceCard`）
6. 调整 `RecordRow` 组件:
   - 移除类型副标题显示（`recordTypeLabel` 行）
   - 将标签从正文下方移到标题下方
   - 无标题时显示"未命名记录"而非类型名
7. 调整新建/编辑记录布局: 标题 → 标签编辑器 → 正文
8. 编辑状态支持自动保存（已有 autosave）

### 第四步：侧栏点击滚动 ✓
**文件**: `src/components/layout/ProjectSidebar.tsx`, `src/components/project/ProjectOverviewPage.tsx`

1. 侧栏点击调用 `onOpenRecord(recordId)`
2. 在项目页实现: 导航到 `/projects/:projectId?focus=record-{id}`
3. 利用现有的 `scroll-mt-6` 和 `id="record-{note.id}"` 实现自动滚动

### 第五步：设置面板清理 ✓
**文件**: `src/components/settings/SettingsDialog.tsx`

1. 从 `SETTINGS_SECTIONS` 数组移除 `record-types` 条目
2. 保留 `RecordTypeSettingsPanel` 组件代码但不渲染

### 第六步：测试更新 ✓
**文件**: `src/components/project/ProjectOverviewPage.test.tsx`, `src/components/layout/ProjectSidebar.test.tsx`

1. 更新测试断言，移除记录类型文案相关断言
2. 添加时间线渲染、搜索筛选的测试用例

## 风险与依赖
- `noteType` 字段保留，新建时继续写入默认值，确保数据完整性
- `recordGroups` 保留为空数组，避免其他未知引用报错
- 侧栏已接收扁平 `records` 数组，无需大改
- 搜索/筛选使用前端实现（计划文档说明）

## 验证方式
1. `npm run build` 通过
2. `npm run test:unit -- src/components/project/ProjectOverviewPage.test.tsx src/components/layout/ProjectSidebar.test.tsx` 通过
3. `cargo fmt && cargo check` 通过
4. 手动测试: 创建记录、搜索、标签筛选、侧栏点击滚动
