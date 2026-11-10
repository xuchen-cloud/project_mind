# Office 缩放工作包

## 用户直接需求
- DOCX / XLSX / PPTX 缩放统一限制为 50%–150%。无关联 Issue。
- 依赖：现有 DOCX 固定上游构建适配、XLSX/PPTX vendor 与共享 editor-chrome。
- 交付：按钮、滑条、输入、快捷键、滚轮/捏合、fit 与已有视图恢复均受范围约束；保留 100% 默认及范围内 fit 语义。
- 非目标：保存/打开逻辑、其他功能、发布；不启动 GUI、不做 npm/Rust 全量构建、不提交/push。其他 agent 只审查。
- 验收：真实缩放入口无越界路径，现有针对性缩放/转换测试通过；Standards / Spec 与 full-review 各维度自行检查，记录限制。
- 验证范围：复用现有缩放单测、preview restore 与 DOCX 构建转换测试，必要时更新范围断言；diff/check。禁止新增镜像实现测试。已有 full-review 会话由主任务管理，本包不改其状态或产物。

## 执行记录
- 已读 AGENTS.md、publish-flow、三格式包说明和 full-review 技能；修改前未发现 Tauri/Vite 自动重启进程。
- 当前工具没有子 agent 委派接口，本包由当前 agent 直接实现和审查，不另建 chat。

## Full-review 1：质量 / 架构（Standards）

仅复用各包现有 esbuild onLoad 适配；vendor 字节与 source lock 不变，新增精确匹配失效即报错。DOCX/PPTX 保持原 setter 接口，统一约束数字值和函数更新；未新增依赖、通用框架或保存/打开分支。已检查 setter 的真实调用方、手势预览与 fit 路径。无未解决发现。

## Full-review 2：安全 / 性能

缩放输入在实际状态或 Univer 命令边界收敛；XLSX 快照直接创建工作簿的旁路在现有 scene 初始化监听中限幅，并同步其视图 config。此为审查发现并已修复的问题，未改草稿恢复事务。没有新增 I/O、计时器或重渲染循环；命令监听随原 runtime 清理。安全/性能无未解决发现。

## Full-review 3：测试 / 文档

更新现有 Windows/POSIX hook 测试，执行真实 DOCX/XLSX 范围与预设转换；现有 Univer 测试执行真实 controller listener，检查 10/50/100/150/400% 的场景缩放和 config。PPTX 现有转换测试覆盖范围、梯级、state updater 和 fit。DOCX presentation 浏览器脚本原输入40%的预期改为50%，本轮不启动浏览器。额外一次内存执行探针验证真实转换后算法、数字/函数式 setter、PPTX fit、XLSX 命令/operation 与 preview restore，未新增镜像实现测试。

## Full-review 4：最佳实践 / 交付（Spec）

50–150 范围由各格式既有范围模块提供；状态栏按钮/滑条、输入对话框、快捷键、滚轮/捏合和 fit 共用它。100% 初始值与 reset 保留；fit 仍计算原有几何，只在结果越界时停在50/150，窄视口保留滚动。XLSX 既有文件缩放映射、预览视图恢复、草稿快照恢复和切表均已检查。不新增 CI 或发布门禁；遵循用户要求不构建产物、不运行 GUI、不提交/push。

## Full-review 5：结论

Standards / Spec 自查与 full-review 五阶段已完成，范围内没有未解决缺陷。用户已授权直接完成，不执行技能中的重复确认；本次阶段记录隔离在此文件，未覆盖主任务的 full-review 会话。未声称 GUI 或重建后集成验收完成。

## 改动文件

1. `packages/office-docx/renderer-build.mjs`：50/150 范围、150%预设、统一状态更新限幅。
2. `packages/office-docx/test/windows-renderer-hooks.test.mjs`：复用现有跨平台转换测试，补范围/预设与真实 Univer 快照视图限幅检查。
3. `packages/office-docx/test/browser-presentation.mjs`：原输入40%的结果预期修正为50%。
4. `packages/office-pptx/parity-text-edit-build.mjs`：50/150范围及有效梯级、状态更新限幅、fit限幅。
5. `packages/office-pptx/test/build-portability.test.mjs`：复用现有转换测试补相应断言。
6. `packages/office-xlsx/scripts/build-renderer.mjs`：范围/预设、已有缩放值映射、命令与operation输入限幅及监听清理。
7. `packages/office-xlsx/scripts/patch-univer.mjs`：原生范围及快照/切表的 scene 初始化限幅。
8. `.full-review/zoom-change.md`：本包需求、审查与验证记录。

## 验证证据

基线 HEAD：`fe9fe9c188f05c23bae369074446e38c0859a0c8`。仅验证上述改动范围；工作区其他并行变更不属于本包。

- `node --test packages/office-docx/test/windows-renderer-hooks.test.mjs packages/office-pptx/test/build-portability.test.mjs packages/office-xlsx/tests/preview-view.test.mjs packages/office-xlsx/tests/loaded-visual-scroll.test.mjs`：11/11通过。补齐快照场景断言后只重跑受影响的 `node --test packages/office-docx/test/windows-renderer-hooks.test.mjs`：6/6通过；其他5项结果复用。
- `node --input-type=module` 内存探针：从实际 onLoad 回调取得转换结果，以 TypeScript transpile + VM 执行原始 wheel helpers、三格式实际缩放模块及 App setter / fit / command listener；覆盖负数、10/49/50/75/100/150/151/400/500%、函数更新、梯级、滚轮/捏合、XLSX preview restore 165/400%。结果 PASS。未调用包构建、未输出 renderer 产物。
- `node packages/office-xlsx/scripts/source.mjs`：exit 0，锁源验证通过。
- `node packages/office-pptx/sources.mjs`：515 GenOffice sources + 4 Web adaptation sources 验证通过。
- `node packages/office-docx/prepare-source.mjs --verify-only`：519 GenOffice files 验证通过。
- 三个构建适配脚本及 `patch-univer.mjs` 的 `node --check` 通过；相关文件 `git diff --check` 通过。
- 未运行 npm/Rust 全量构建、包构建、GUI或浏览器；`browser-presentation.mjs` 仅更新断言并检查语法。dist/staging 保持已有产物，主任务后续集中构建与原生验收后才会应用到运行实例。
- 无提交、push或发布。其他 agent 修改的 dsh-ui / provenance / full-review 文件未触碰。
