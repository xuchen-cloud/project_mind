# 存量导入 File 的首次身份确认

关联 [#266](https://github.com/xuchen-cloud/project_mind/issues/266)。基线 `develop` 的 `12d09c4`。

## 工作包

- 依赖：已有目录 File 的身份核对、归属校验、不可变版本快照、版本与内容 CAS。
- 交付行为：存量导入没有物理身份时，应用内打开显示中文说明并展开位置核对。已有内容校验值时，带入当前位置，继续使用现有位置或内容替换确认。
- 更早的导入可能连内容校验值也没有：用户明确确认当前位置内容后，将其登记为新的 File Version，保留 File ID、原文件位置、旧版本元数据和旧引用；旧版本仍未经核验，不回填旧版本校验值。
- 成功确认后，当前预览直接重载；版本列表尚未进入查询缓存时也必须生效。
- 非目标：自动绑定不明身份、推断外部移动目的地、批量重新导入、修复未知旧字节、扩大量级和快照预算。

## 边界

缺失校验值的首次登记只适用于缺少物理身份记录的遗留导入，且必须确认其现有路径。已有校验值的 File 仍按原有位置与替换协议核对。所有操作继续检查实际 Workspace / Project 归属、版本与校验值变化、路径边界、其他 File 的物理归属及快照预算。

登记当前字节不表示恢复了旧版本的原始字节。保留的旧版本记录不能因为用户确认当前内容而获得新的可信校验值。

## 验收与验证

1. 构造真实遗留导入，移除身份与校验值记录，首次 resolve 返回待确认；未经明确确认不能登记。
2. 确认后生成独立新版本快照，原文件和 File ID 不变；重开仍能读取新版本，旧版本校验值仍缺失。
3. 拒绝陈旧版本、校验值并发变化、其他 File 的物理归属和不同路径；超限不产生新版本。
4. 前端覆盖已有校验值与缺失校验值两条恢复路径、失败可重试及无版本查询缓存时的直接预览重载。
5. 集中执行受影响的 Rust 目录 File、版本、导入与路径测试，前端位置操作、预览、工作台、API 测试及类型和静默编译检查。主 agent 完成 Standards / Spec 自查。

平台无关协议在 macOS 验证。Windows 原生界面及旧工作区回测需使用包含修复的新安装包。

## 执行记录

基线 `12d09c4` 上的本包最终源码通过以下验证，未启动应用窗口。

| 范围 | 命令与结果 |
| --- | --- |
| TDD | 原生真实遗留 fixture 使用旧接口时因拒绝 `registration` 失败；前端新增 3 项因缺少恢复动作和当前位置而失败。修复后通过 |
| 原生目录 File、导入、版本内核与服务、绑定路径 | `TMPDIR=/private/tmp cargo test --manifest-path src-tauri/Cargo.toml --lib --quiet -- db::project_directory_files::tests db::file_imports::tests db::file_versions::tests file_version_service::tests project_directory::bound_tests`：152 通过，6 个既有子进程辅助项 ignored |
| 前端位置核对、预览、工作台和 API | `npx vitest run src/components/document/ProjectFileIdentityActions.test.tsx src/components/document/ProjectFileContent.test.tsx src/components/project/ProjectContentWorkspace.test.tsx src/components/project/ProjectContentLayoutView.test.tsx src/services/projectFileApi.test.ts --maxWorkers=1`：163 通过 |
| 恢复预览的版本语义 | 将集成样例细化为已有 hash 保持版本、无 hash 新增版本后，仅重跑 `ProjectFileContent.test.tsx -t 'explicit recovery'`：2 通过；其余已通过用例未改，复用结果 |
| 编译与规范 | `cargo check --manifest-path src-tauri/Cargo.toml --quiet`、`npx tsc --noEmit`、`npx vite build`、`node scripts/check-ui-standards.mjs`、`node scripts/check-bundle-boundaries.mjs`、`git diff --check` 均通过 |

类型检查首次发现本地 Office DOCX 的生成声明过期。完整 Office 重建被上游源文件下载失败阻断后，按其 `build.mjs` 现有 TypeScript 声明生成步骤更新忽略的 `dist` 声明文件，再通过类型检查；未修改 Office 源码或依赖。本包前端构建使用 `npx vite build`，不声称已产出新的 Windows 安装包。

### 双轴自查

- Standards：主 agent 检查完整变更及调用路径；缺失 hash 通过显式动作进入，Project/File 锁内进行版本与 hash CAS，身份归属锁内保留最终所有权和快照字节核验。没有引入自动猜测、静默降级或重试。无剩余发现。
- Spec：已有 hash 的首次确认保持版本；无 hash 的确认只登记现有路径的新版本，旧版本不回填 hash。恢复意图、外来物理归属、预算与并发变化均有回归；成功操作在没有查询缓存时也能恢复预览。无剩余发现。
- 没有启动 review 子 agent。文件位置面板继续使用现有 `HomeSidebarList` 的动态边缘遮罩。
