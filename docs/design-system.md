# Project Mind Alpha Design System

状态：当前正式基线  
更新时间：2026-06-08

## 1. 目的与边界

这是一套服务于当前代码实现的轻量设计系统。

它的职责是：

- 记录已经落在代码中的视觉基础与交互规则
- 统一当前工作区产品的语义
- 帮助后续实现维持一致

它当前不承担：

- 多主题系统
- 完整 token 平台
- 面向营销站点的品牌规范
- 为历史遗留页面继续扩充旧组件族

当前实现基线主要对应：

- [src/styles/app.css](/Users/xuchen/On%20My%20Mac/project_mind/src/styles/app.css)
- [src/ui/components](/Users/xuchen/On%20My%20Mac/project_mind/src/ui/components)
- [src/components/layout](/Users/xuchen/On%20My%20Mac/project_mind/src/components/layout)
- [src/components/workspace](/Users/xuchen/On%20My%20Mac/project_mind/src/components/workspace)
- [src/components/project](/Users/xuchen/On%20My%20Mac/project_mind/src/components/project)
- [scripts/check-ui-standards.mjs](/Users/xuchen/On%20My%20Mac/project_mind/scripts/check-ui-standards.mjs)

## 2. 设计方向

当前界面应保持以下气质：

- 稳定
- 克制
- 可信
- 适合长时间工作的编辑型工作台

它不是：

- 通用 SaaS 仪表盘
- 娱乐化效率工具
- 强装饰的 AI 产品壳

持续有效的方法论：

- `state before detail`
- `fast capture, deliberate structure`
- `layered information`
- `calm density`
- `local confidence`

## 3. 表达规则

### 3.1 先减法，再布局

默认先问：

- 这段信息是否真的需要出现
- 一个信号能否讲清楚
- 是否能用一行完成表达

具体规则：

- 能用文本解决的，不强行卡片化
- 能用 badge 解决的，不强行字段化
- 只读信息不伪装成输入框
- 不为“看起来完整”补无效说明

### 3.2 主编辑面优先

当前产品是编辑型工作台，所以主视觉资源要优先给：

- Workspace主区
- QuickNote
- Record正文

而不是优先给：

- 装饰性卡片
- 过度边框
- 多余浮层

### 3.3 长驻工具侧区

侧边栏和 Todo Rail 是长期驻留工具，不应看起来像临时插入物。

因此：

- 背景层级要弱于主编辑区
- 交互要直接
- 信息要紧凑但不压迫

## 4. Foundations

### 4.1 色彩

当前核心色彩语义：

- 暖白主背景
- 轻微分层的浅灰背景
- 克制的蓝绿色强调
- 明确但不刺眼的危险色

设计意图：

- 主区适合长文阅读与编辑
- 侧区与轻浮层通过背景层级区分，而非强阴影堆砌
- 强调色只用于选中、激活、关键 CTA 与轻量焦点反馈

### 4.2 字体

当前字体方向是“编辑型工作台”，而非通用系统默认感。

项目中使用的关键字体资源包括：

- `Work Sans`
- `Noto Sans SC`
- 预留的衬线正文方案

要求：

- UI 文本保持清晰、紧凑
- 长正文阅读不应显得机械或拥堵

### 4.3 文字层级

当前文本层级重点是：

- `caption`
- `ui`
- `body`
- `title`
- `headline`
- `display`

使用原则：

- `body` 是主工作面默认层级
- `ui` 用于控件和轻说明
- `caption` 只用于弱标签、统计与眉题

### 4.4 圆角与阴影

当前整体偏克制：

- 小组件使用 6px 到 8px 圆角
- 模态与较大浮层使用更高圆角
- 阴影只在浮层与对话框中明显出现

## 5. 当前界面骨架

### 5.1 Workspace Gate

应像正式起始页，而不是占位对话框。

要求：

- 有明确的主次操作
- 有最近工作区回流
- 有稳定、可信的第一印象

### 5.2 Top Bar

顶栏是工作区级控制带。

要求：

- 轻量
- 紧凑
- 持续可扫读
- 不把项目标签做成笨重导航条

### 5.3 主区

主区视觉优先级最高。

要求：

- 足够宽
- 滚动清晰
- 在 `QuickNote / Record` 两种视图中都能保持稳定节奏

### 5.4 Sidebars 与 Rails

当前有三类长期侧区：

- 工作区侧边栏
- 项目侧边栏
- Todo Rail

共同规则：

- 背景弱于主区
- 搜索与切换动作靠前
- 列表项 hover 和 active 状态需要清楚但克制

## 6. 组件语义

### 6.1 `SurfaceCard`

当前主要用于：

- AI 卡片
- 空态容器
- 编辑块承托

规则：

- 不要把所有内容都套进 `SurfaceCard`
- 只有在确实需要层级抬升时才使用

### 6.2 `Button` / `IconButton`

规则：

- `primary` 只留给真正的确认或主要动作
- `secondary` 用于明确但不最高优先级的动作
- `ghost` 用于工具带与轻操作

### 6.3 `SearchField`

当前搜索是高频操作。

要求：

- 占位词直指对象范围
- 清除操作尽量就地
- 不额外包裹冗余标题

### 6.4 `StatusBadge`

用途：

- 对象类型
- 数量
- 辅助状态

规则：

- 用于补充语义，不代替主文本
- 不要堆太多不同色彩 badge

### 6.5 `RichEditor`

这是当前产品最重要的主组件之一。

它应呈现出：

- 清爽的正文编辑面
- 结构化增强而不抢戏
- 适合持续书写的阅读节奏

当前主要变体：

- `page`
- `bare`

## 7. 交互规则

### 7.1 QuickNote / Record切换

切换按钮应始终简洁且稳定，不做夸张分段控件。

### 7.2 选中态

选中态强调必须足够可见，但不应破坏整体温和基调。

适用于：

- 侧边栏当前项
- 顶栏当前页签
- 当前视图切换按钮

### 7.3 搜索与筛选

搜索和筛选是辅助定位，而不是主叙事。

因此：

- 应足够近
- 应足够轻
- 不应盖过正文工作面

### 7.4 窄窗口适配

当前产品在窄窗口下主要依赖：

- 页面宽度设置
- 侧边栏折叠
- Todo Rail 折叠

这些能力是正式交互，而不是调试工具。

## 8. 当前不建议的做法

- 把更多旧流程卡片继续堆回项目首页
- 为了“信息丰富”而增加厚重边框和说明文案
- 用系统原生粗糙控件破坏整体语气
- 在主编辑区上叠加太多颜色和状态层
- 把 AI 结果做成主视觉压过用户自己的笔记
