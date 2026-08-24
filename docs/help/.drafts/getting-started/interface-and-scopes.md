## 看懂界面与内容作用域

Project Mind 把正在处理的内容放在中间，把定位入口放在左侧，把需要持续推进的 Todo 放在右侧。先分清这几个区域，再看懂 Workspace 与 Project 的作用域，就不容易把“我在哪里看到它”误认为“它属于哪里”。

<!-- SCREENSHOT: getting-started-interface-and-scopes-overview.png | Project Mind 完整 Workspace 界面标注图，依次标出顶栏、左侧栏、主区和右侧 Todo Rail；使用脱敏后的 Workspace 路径与虚构内容 -->

### 顶栏：在 Workspace 与打开的 Project 之间切换

顶栏贯穿当前 Workspace，主要用于：

- 回到 `Workspace` 页面；
- 在已经打开的 Project 页签之间切换或关闭页签；
- 使用全局搜索；
- 打开设置。

Project 页签只是访问入口。关闭一个页签不会删除或 Archive 该 Project，也不会改变其中 Record、Todo 或 File 的归属。

### 主区：写 QuickNote，或浏览 Record

Workspace 页面与 Project 页面都可以在 `QuickNote` 和 `Record` 之间切换：

- `QuickNote` 用来接住还没决定最终形式或沉淀位置的内容；
- `Record` 用来保存已经值得保留、可以独立查找和引用的信息。

页面标题会告诉你当前处于 Workspace，还是某个具体 Project。这个位置很重要：Workspace 主区中的内容属于 Workspace；Project 主区中的内容属于当前 Project。

因此，在 Workspace 的 `Record` 视图创建的是 Workspace Record；在“智能客服知识库升级”的 `Record` 视图创建的则是该 Project 的 Project Record。两者都叫 Record，但真实归属和生命周期不同：Workspace Record 不依赖某个阶段性 Project，Project Record 则随所属 Project 一起保留和管理。

### 左侧栏：定位当前范围内的内容

左侧栏会随页面范围变化：

- 在 Workspace 页面，左侧栏可在“项目”和“记录”之间切换。你可以打开 Project，或搜索、新建和打开 Workspace Record。
- 在 Project 页面，左侧栏可在“记录”和“文件”之间切换。这里的搜索、Tag 筛选、新建 Record 和导入 File 都只针对当前 Project。

侧栏负责定位，不负责改变归属。例如，从 Workspace 左侧栏打开“智能客服知识库升级”，只是进入这个 Project；Project 中原有的 Record 和 File 仍然属于它。

### Todo Rail：在不离开上下文的情况下推进 Todo

右侧的 `Todo List` 是 Todo Rail。你可以在这里查看未完成或已完成的 Todo，并就地创建、完成、编辑和补充进展。Todo Rail 可以收起，但收起不会影响任何 Todo。

Todo Rail 有两种查看范围：

| 查看范围 | 会显示什么 | 不会显示什么 |
| --- | --- | --- |
| `Workspace View` | Workspace Todo，以及所有未进入 Archive 的 Project 所拥有的 Project Todo | 已 Archive Project 的 Project Todo |
| `Current Project View` | 只属于当前 Project 的 Project Todo | Workspace Todo、其他 Project 的 Project Todo |

Workspace 页面始终使用 `Workspace View`。在 Project 页面，Todo Rail 默认使用 `Current Project View`；点击标题栏中的视图切换按钮，可以临时切到 `Workspace View`，再次点击则切回当前 Project。

在 `Workspace View` 中，你还可以选择分组或平铺显示。分组时，`Workspace` 和各 Project 的名称会作为分组标题，帮助你确认来源；平铺时，Todo 卡片不会重复显示这些来源名称。

> `Workspace View` 与 `Current Project View` 只描述 Todo 的查看范围，不是整个 Workspace 页面与 Project 页面的另一套模式。

### 看到的位置不会改变真实归属

切换 Todo 视图只是在查看同一批 Todo 的不同集合，不会移动、复制或重新归类 Todo。

例如，“整理退款进度类问题的标准答案”是“智能客服知识库升级”的 Project Todo：

1. 在该 Project 的 `Current Project View` 中，你会看到它。
2. 切到 `Workspace View` 后，你仍会看到它；分组显示时，它位于“智能客服知识库升级”组中。
3. 回到 Workspace 页面，你也会在 `Workspace View` 中看到它。

无论从哪里看到或编辑，这条 Todo 都仍属于“智能客服知识库升级”。它继续使用该 Project 的 Project Tag，也只能按该 Project 的规则创建 Internal Reference。

创建位置同样需要留意：

- 在 `Current Project View` 中创建 Todo，它直接成为当前 Project 的 Project Todo。
- 在 `Workspace View` 中创建 Todo，归属默认为 `Workspace`；只有在“Todo 归属”中显式选择某个未进入 Archive 的 Project，才会创建该 Project 的 Project Todo。

<!-- DIAGRAM: getting-started-interface-and-scopes-scope-map.png | 作用域示意图：外层为 Workspace，内含 Workspace Record、Workspace Todo、Workspace Tag 与两个独立 Project；Workspace View 用虚线汇集 Workspace Todo 和两个未归档 Project Todo，Current Project View 只圈出当前 Project Todo；箭头强调“显示范围不改变归属” -->

### 四类内容的作用域边界

#### Record

- Workspace Record 直接属于 Workspace，适合没有预定结束时间、跨 Project 或不依赖某个 Project 的长期内容。
- Project Record 只属于一个 Project，用来保存该 Project 中的事件、材料、观察或判断。
- 在搜索结果或其他入口中打开 Record，不会改变它的归属。

#### Tag

- Workspace Tag 只用于 Workspace 范围对象，不能附着到 Project 或 Project 范围对象。
- Project Tag 只用于一个特定 Project 内的 Record、Todo 和 File，不能跨 Project，也不能用于 Workspace 范围对象。
- 两个范围可以有同名 Tag，但它们仍是彼此独立的 Tag。例如 Workspace Tag `#待确认` 与“智能客服知识库升级”中的 Project Tag `#待确认` 不会自动合并。

#### Todo

- Workspace Todo 直接属于 Workspace，适合个人事务、跨 Project 事项，或无需建立 Project 的行动。
- Project Todo 只属于一个 Project，用来推进该 Project 的结果。
- Todo 出现在 `Workspace View` 中只表示它被纳入工作区当前工作范围，不表示它已经变成 Workspace Todo。

#### Internal Reference

Internal Reference 是对象之间可以点击跳转的上下文连接，不是归属关系，也不会改变 Tag 的作用域。

- Workspace 范围对象可以引用 Project 对象。
- Project 范围对象只能引用同一个 Project 内的对象，不能引用 Workspace 对象或其他 Project 的对象。

例如，Workspace Todo 可以引用“智能客服知识库升级”中的 Project Record，方便从跨 Project 行动回到具体材料；但该 Record 仍属于原 Project，Record 上的 Project Tag 也不会因此成为 Workspace Tag。

### 一个简单的判断方法

当你不确定内容该放在哪里时，先问一句：它是否依赖某个有明确结果、会结束的 Project？

- 如果不依赖，创建 Workspace Record、Workspace Todo，并使用 Workspace Tag。
- 如果依赖，先进入对应 Project，再创建 Project Record、Project Todo 或 File，并使用该 Project 自己的 Project Tag。
- 如果只是需要从一处回到另一处，用 Internal Reference 建立连接，不要把连接理解成移动内容。

### 接下来可以看

- 想建立或整理 Project，请看“创建、切换、归档与恢复 Project”。
- 想进一步选择 Workspace Record 或 Project Record，请看“把值得保留的内容沉淀为 Record”。
- 想了解 Todo 创建与聚合规则，请看“分清 Workspace Todo 与 Project Todo”。
- 想了解允许的引用方向，请看“用 Internal Reference 连回上下文”。
