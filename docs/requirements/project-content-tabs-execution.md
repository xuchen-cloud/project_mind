# 项目内容 Tab 实施记录

日期：2026-10-11。父 Issue：#124。规格：[完整需求](project-content-tabs.md)、[handover](project-content-tabs-handover.md)。

## 接收基线

- HEAD `91b35defa55a8dc36b3e50de10127b0652800df5`，分支 `codex/ai-enhancement`。已有 AI 设置、Overview 与 Voice 等未提交改动必须保留；本任务只提交明确属于本包的文件或差异。
- 当前用户进程为 `tauri dev --no-watch`；源码编辑不会触发原生重启。静默验证，GUI 集中执行前告知。
- 已有 File 版本/CAS/恢复/SourceRef、canonical Record 保存协调、真实 DSH Chat/Trajectory 与单项目运行时、目录读取边界，全部复用。
- 缺口：目录尚未纳入 File 身份、单一 File 预览请求、两条 Record 缓存仅单可见、DSH 当前 Session 可变、没有 Project 内容布局。

## 本轮包范围

| 包 / Issue | 依赖 | 交付 / 文件范围 | 非目标 | 验收与验证 |
| --- | --- | --- | --- | --- |
| WP1 / #124，复用 #114 | File/Version 原生能力 | 目录纳管、身份核对、版本读取；原生 File/目录服务和对应 DTO/API | 不新增通用数据库、自动清理 | A10–A19、A29–A30；原生身份/版本/路径针对性测试 |
| WP2 / #124 | 稳定对象身份 | 新布局 store/model；统一打开、唯一性、分栏/移栏/合并/恢复；主应用内容外壳 | 不复用 Session 布局为权威 | A01–A09、A31–A32；布局和真实页面接入测试 |
| WP3 / #124 | WP2 | ProjectNoteFocusPage 的 visible/focused 与保存协调；Record 内容接入 | 不重写编辑器或改变 AI 预览规则 | A04–A05、A08、A24、A28；双 Record 和保存失败测试 |
| WP4 / #124，协作 #115/#118 | WP1/WP2 | DSH 固定预览来源、File/Version 输入、必要资源与生命周期 | Office 编辑与回存仍归 #118 | A17–A23、A28；格式样例、版本和资源测试 |
| WP5 / #124 | WP1/WP2、真实 runtime | DSH adapter 每页 Session 绑定、内容会话入口、明确引用目标 | 不无依据承诺跨项目并行 | A18–A20、A25–A28；双 Session/引用/延迟回调测试 |
| WP6 / #124 | WP1–WP5 | 目录/Record/会话/搜索/最近访问/引用迁入统一入口，完整验收台账 | 不关闭未完成 #118 | A01–A32；集中受影响完整验证、主 agent 双轴检查 |

## 采用规则

- 采用 §1.2 常规布局默认值：聚焦栏打开；双栏会话文件引用优先另一栏；分栏移动当前 Tab；50% 初始比例；合并保留聚焦选中项；关闭空栏合并；窄窗临时只显示聚焦栏。
- Office 首版只读预览可另包；本轮基本格式清单遵循 P02，不宣称 Office 编辑。
- 不新增自动历史清理；引用版本保留。快照预算、目录排除、身份歧义核对及跨项目运行以工作包实际决策补充。
- Standards / Spec 由主 agent 自行执行；未授权启动 review 子 agent。
- 用户在实施会话明确确认首版跨 Project 后台并行。WP5 扩展 Project 独立运行时/连接；A27 改为运行中切项目不中止原任务，返回后历史和停止目标正确。原 §1.2 阻止跨项目切换建议不再采用。

## 验证与验收

实施中逐包补充命令、覆盖范围、结果和真实平台证据。A01–A32 当前均未通过本轮验收；已有基础验证只可在相关代码与环境未变时复用。Windows 平台未提供，不能标记通过。完整确认范围交付前 #124 保持开放。

### WP2 状态与打开边界阶段

- 文件：`project-content-layout.ts`、`project-content-store.ts`、`projectContentApi.ts` 及对应测试。
- 状态验证：布局与 Store 25/25 通过；独立严格 TypeScript 检查通过。统一打开边界 7/7 通过；覆盖异步并发唯一性、权威 Record/File 归属、数字 ID 规范化、未知 Session、旧 Workspace 代次与取消。
- 主 agent Standards：布局只保存身份和视图元数据；入口调用现有原生业务服务核验，异步后核对 binding/generation；同步状态更新保证两栏去重；无新业务数据库。
- 主 agent Spec：默认单栏、显式分栏、项目独立布局、跨栏唯一、普通重复打开保留视图、明确版本更新同 Tab、移动/排序/合并和项目局部恢复已具模型证据。真实页面、关闭与 GUI 仍依赖 WP3–WP6，未将本阶段写为 A01–A09 整体通过。
- 本阶段可提交；#124 继续开放。
