# 侧边栏文件功能增强

## 背景

之前的文件模块现在没有入口了，之前文件卡片（`ManagedDocumentSection`）支持的插入文件、修改文件名、修改文件版本等能力需要在侧边栏中恢复。

## 目标

将 `ManagedDocumentSection` 中的核心文件管理能力迁移到 `ProjectSidebar` 的文件标签页中。

## 功能清单

### 阶段一：核心操作能力（高优先级）✅

- [x] **1. 添加右键菜单**
  - [x] 菜单组件框架
  - [x] 打开文件所在位置
  - [x] 重命名
  - [x] 复制为新版本并打开
  - [x] 标星/取消标星
  - [x] 删除
  - [x] 标签管理复选框

- [x] **2. 文件重命名功能**
  - [x] 双击文件名进入编辑模式
  - [x] 通过右键菜单触发
  - [x] 失效文件不可重命名
  - [x] Enter 提交，Escape 取消

- [x] **3. 文件删除功能**
  - [x] 通过右键菜单触发
  - [x] 调用删除 mutation

- [x] **4. 打开文件所在位置**
  - [x] 通过右键菜单触发
  - [x] 调用 desktopApi.revealInExplorer

### 阶段二：版本管理（中优先级）✅

- [x] **5. 显示版本号**
  - [x] 在文件名旁显示版本号徽章
  - [x] 仅当 versionCount > 1 时显示

- [x] **6. 版本下拉菜单**
  - [x] 复用 DocumentVersionDropdown 组件
  - [x] 列出所有历史版本
  - [x] 点击打开对应版本

- [x] **7. 复制为新版本并打开**
  - [x] 通过右键菜单触发
  - [x] 调用 documentAddVersionMutation

### 阶段三：标签管理（中优先级）✅

- [x] **8. 文件标签管理**
  - [x] 右键菜单中的标签复选框列表
  - [x] 支持添加/移除标签
  - [x] 乐观更新

- [x] **9. 文件标星功能**
  - [x] 通过右键菜单触发
  - [x] 标星文件置顶显示
  - [x] 图标状态切换

### 阶段四：导入与拖拽（低优先级）✅

- [x] **10. 文件拖拽导入**
  - [x] 支持拖拽文件到侧边栏
  - [x] 显示拖拽提示反馈

- [x] **11. 文件导入按钮**
  - [x] 集成文件导入流程
  - [x] 支持标签选择对话框

### 阶段五：交互增强（低优先级）✅

- [x] **12. 键盘导航支持**
  - [x] Enter 键打开文件
  - [x] ContextMenu 键打开菜单
  - [x] Escape 关闭菜单

- [x] **13. 失效状态增强处理**
  - [x] 显示"失效"徽章
  - [x] 失效文件禁用相关操作
  - [x] 错误提示

## 技术实现

### 数据结构扩展

`ProjectSidebarDocumentItem` 需要补充以下字段：
- `baseName: string` - 文件基础名称
- `isStarred: boolean` - 是否标星
- `currentVersionNumber: number` - 当前版本号
- `versionCount: number` - 总版本数
- `health: "normal" | "missing"` - 文件健康状态
- `originalPath: string` - 原始路径
- `historyDirPath: string` - 历史目录路径

### 组件复用

从 `ManagedDocumentSection` 复用：
- `DocumentVersionDropdown` - 版本下拉菜单
- `DocumentContextMenuAction` - 右键菜单项
- `DocumentTagDots` - 标签圆点显示

### Hooks 复用

- `useDocumentMutations` - 文件操作（重命名、删除、更新元数据、添加版本）
- `useDocumentImportFlow` - 文件导入流程

### Props 扩展

`ProjectSidebar` 需要新增的回调：
- `onRenameDocument?: (document, newName) => void`
- `onDeleteDocument?: (document) => void`
- `onToggleStarDocument?: (document) => void`
- `onUpdateDocumentTags?: (document, tagIds) => void`
- `onAddDocumentVersion?: (document) => void`
- `onRevealDocument?: (document) => void`
- `onImportFiles?: () => void`
- `onDropFiles?: (paths: string[]) => void`

## 实施日志

### 2026-06-07

- [x] 创建功能增强跟进文档
- [x] 提取可复用组件到 `DocumentSharedComponents.tsx`
- [x] 更新 `ProjectSidebarDocumentItem` 接口，添加完整字段
- [x] 实现右键菜单完整功能
- [x] 实现文件重命名（双击和右键菜单）
- [x] 实现文件删除
- [x] 实现打开文件所在位置
- [x] 实现版本管理（显示版本号、版本下拉菜单、创建新版本）
- [x] 实现文件标星功能（标星文件自动置顶）
- [x] 实现标签管理（右键菜单中添加/移除标签）
- [x] 实现文件拖拽导入
- [x] 集成文件导入流程（支持标签选择）
- [x] 添加"导入文件"按钮
- [x] 实现键盘导航支持（Enter、ContextMenu、Escape）
- [x] 实现失效文件状态处理
- [x] 修复所有 TypeScript 类型错误
- [x] 更新 `App.tsx` 中的文档映射
- [x] 更新所有测试用例
- [x] 添加 QueryClientProvider 到测试

### 待测试的功能

- [ ] 验证拖拽文件到侧边栏是否正常工作
- [ ] 验证单击文件是否能正常打开（使用 180ms 延迟）
- [ ] 验证"导入文件"按钮是否正常工作
- [ ] 验证所有右键菜单功能
- [ ] 验证文件重命名功能
- [ ] 验证版本切换功能

## 技术细节

### 创建的新文件

1. **`/src/components/document/DocumentSharedComponents.tsx`**
   - 提取可复用的文档组件和辅助函数
   - `DocumentContextMenuAction` - 右键菜单项组件
   - `DocumentTagDots` - 文件标签圆点显示
   - `DocumentVersionDropdown` - 版本选择下拉菜单
   - 辅助函数：`canRenameDocument`, `stopPropagation`, `handleRenameKeyDown`, `isInteractiveTarget`

### 修改的文件

1. **`/src/components/layout/ProjectSidebar.tsx`**
   - 新增完整的文件管理功能
   - 右键菜单：打开位置、重命名、新版本、标星、删除、标签管理
   - 双击文件名进入编辑模式
   - 版本号显示和版本切换
   - 文件拖拽导入
   - 标星文件置顶排序
   - 失效文件特殊处理
   - 键盘导航支持

2. **`/src/App.tsx`**
   - 更新 `toProjectSidebarDocuments` 函数，映射完整的文档字段
   - 添加 `project.id` 到 `ProjectSidebar` props

3. **`/src/components/layout/ProjectSidebar.test.tsx`**
   - 更新所有测试用例，添加缺失的字段（`id`, `baseName`, `isStarred`, `health` 等）

4. **`/src/components/project/ProjectOverviewPage.tsx`**
   - 修复 `DocumentTagRecord` 到 `FileTagRecord` 的类型转换

### 复用的 Hooks

- `useDocumentMutations` - 文件操作（重命名、删除、更新元数据、添加版本）
- `useDocumentImportFlow` - 文件导入流程（拖拽、选择文件、标签选择）
- `useFeedbackStore` - Toast 提示
- `useUiStore` - UI 状态管理

### 新增的交互功能

1. **双击重命名** - 双击文件名进入编辑模式
2. **右键菜单** - 完整的文件操作菜单
3. **拖拽导入** - 拖拽文件到文件标签页
4. **版本切换** - 点击版本号查看和打开历史版本
5. **标签管理** - 右键菜单中快速添加/移除标签
6. **键盘导航** - Enter 打开、ContextMenu 菜单、Escape 关闭

### 视觉增强

1. **标星图标** - 标星文件显示金色星标
2. **失效徽章** - 失效文件显示红色"失效"标签
3. **版本徽章** - 多版本文件显示 "v1", "v2" 等徽章
4. **标签圆点** - 文件标签以彩色圆点形式显示
5. **拖拽反馈** - 拖拽时显示上传提示

## 成果总结

✅ **所有 13 项功能全部实现完成**

现在侧边栏的文件功能已经完整恢复了之前 `ManagedDocumentSection` 的所有核心能力：

- ✅ 完整的右键菜单操作
- ✅ 文件重命名（双击和右键菜单）
- ✅ 版本管理（显示、切换、新建版本）
- ✅ 文件标星和排序
- ✅ 标签管理（添加、移除、筛选）
- ✅ 文件拖拽导入
- ✅ 键盘导航支持
- ✅ 失效文件特殊处理
- ✅ 所有类型检查通过

侧边栏现在提供了完整的文件管理体验，用户可以直接在侧边栏中完成所有文件操作，无需切换到其他页面。

---

**最后更新**: 2026-06-07  
**负责人**: Claude  
**状态**: ✅ 全部完成
