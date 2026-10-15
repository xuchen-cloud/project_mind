# 项目文件排除外部编辑器临时文件

关联：[#184](https://github.com/xuchen-cloud/project_mind/issues/184)，承接 #159 / #142。用户截图中的 `~$` Word owner/锁文件在外部编辑期间生成，关闭文档后消失；旧版本将其纳管，因而显示缺失。

## 工作包

- 依赖现有隐藏规则、自动/显式目录扫描、File 登记/导入、平铺列表及文件树。
- 交付：集中复用临时文件名称判定，自动扫描、直接登记、导入、Agent 创建候选名、树和项目平铺保持一致；已不存在的旧临时文件仍从平铺过滤，保留历史身份和版本。
- 临时文件规则只作用文件。可见目录即使名为 `data.tmp`、`~$资料`，仍可展开，里面正常文档仍纳管。
- 非目标：删除磁盘/历史、读取全部语言的 gitignore、通用忽略配置、运行时联网拉取忽略列表、排除正式备份/恢复材料。
- 验收：根/子目录、自动/显式扫描、直接登记/导入、两种展示、旧缺失锁记录隐藏、正常缺失 File 保留 missing 状态；常规 Office 正本、备份/恢复、SVG、业务锁文件保留。
- 验证范围：先名称规则 red/green，再目录/导入/后台维护回归和 cargo check；无 DTO/IPC/前端及构建资源变化，不重复前端构建。Standards / Spec 主 agent 自查后合入 develop。

## 来源与采用范围

2026-10-15 查阅 GitHub 维护的 [gitignore / Global](https://github.com/github/gitignore/tree/main/Global) 模板，选取外部编辑产生的临时条目。没有整份导入模板中的安装包、快捷方式、正式备份、开发构建产物等规则。

| 类型 | 本包规则 | 依据 |
| --- | --- | --- |
| Office owner/锁文件 | `~$` 前缀，含 Word、Excel、PowerPoint 和无扩展名条目 | [MicrosoftOffice](https://github.com/github/gitignore/blob/main/Global/MicrosoftOffice.gitignore) 的 Office 临时前缀；产品将其统一应用于所有扩展名 |
| 临时工作文件 | `.tmp`、`.temp` 扩展名，大小写不敏感 | 同上 `.tmp` 规则；产品另纳入常见 `.temp` 后缀 |
| Visio 自动保存临时件 | 扩展名以 `~vsd` 开头 | 同上 Visio 临时规则 |
| LibreOffice 锁文件 | 点号开头，沿用 #159 | [LibreOffice](https://github.com/github/gitignore/blob/main/Global/LibreOffice.gitignore) |
| 文本编辑器备份/自动保存 | 尾缀 `~`、`#...#` | [Emacs](https://github.com/github/gitignore/blob/main/Global/Emacs.gitignore)、[Vim](https://github.com/github/gitignore/blob/main/Global/Vim.gitignore) |
| Vim 常见交换文件 | 下划线开头的 `*.sw[a-p]`、`_sw[a-p]`；点号开头者沿用 #159 | 同上 Vim 交换规则的明确子集；保留普通 `macro.swp` 和 `_diagram.svg` |
| Windows 缩略图/目录缓存 | Thumbs.db（含 encryptable 名）、ehthumbs.db、ehthumbs_vista.db、Desktop.ini，大小写不敏感 | [Windows](https://github.com/github/gitignore/blob/main/Global/Windows.gitignore) |

`.wbk`、`.asd`、`.xlk`、`.bak`、`Backup of ...docx` 可能包含用户备份/恢复内容，继续纳管。`Cargo.lock`、`yarn.lock`、`package-lock.json` 也是业务内容，未添加泛化的 `.lock` 排除。

## 执行证据

名称规则用同一生产源文件的独立 Rust 测试先确认 red（1 通过、1 失败，失败为截图中的 `~$解除终止劳动关系.docx`），实现后 2 项通过。该模块无第三方依赖，正式 Cargo 回归继续覆盖实际接入。


## 完整验证与双轴自查

基线为 develop `cbc0a6e`；以下测试对应本包最终原生实现与测试。

- `CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target cargo test --lib --manifest-path src-tauri/Cargo.toml project_directory`：67 通过，1 个既有 ignored 子进程辅助项。
- 同一 target，`cargo test --lib --manifest-path src-tauri/Cargo.toml project_file_exclusions`：2 通过。
- 同一 target，`cargo test --lib --manifest-path src-tauri/Cargo.toml db::file_imports::tests`：11 通过，1 个既有 ignored 子进程辅助项。
- 复用上述构建产物复制为本包独立测试副本后执行 `project_file_maintenance::tests`：3 通过；同一副本的名称规则和导入回归也分别 2 / 11 通过。复用编译产物避免并行工作包替换共享测试程序干扰子进程用例，执行完成后删除副本。
- 首轮新增导入测试两个子目录使用相同目标名，触发现有项目内文件名唯一约束；改为不同名后通过。现有崩溃恢复用例首次失败，复查通过；后台维护 Cargo 调用曾因磁盘空间不足而未启动测试，改用已构建副本验证通过。
- `CARGO_TARGET_DIR=/Users/xuchen/project_mind/src-tauri/target cargo check --manifest-path src-tauri/Cargo.toml`：通过，保留既有警告；磁盘不足后在无编译进程时清理可重建的本 crate incremental 缓存，再执行通过。`git diff --cached --check` 通过。
- Standards：主 agent 检查完整生产与测试 diff，名称策略集中复用；临时文件判断只用于文件，不截断普通目录；保留路径/符号链接/原生隐藏属性边界及真实 I/O 错误；不删除磁盘、历史或版本，无通用忽略框架。无剩余发现。
- Spec：主 agent 对照 #184 与截图核对 Office 编辑锁、临时文件、编辑器交换文件与系统缓存、两种展示、直接登记/导入/Agent 候选名、旧缺失缓存隐藏及正式文件保留，均由实现与回归覆盖。无剩余发现，未启动 review 子 agent。

日志：本机 `/tmp/editor-temporary-{directory,rules,imports,maintenance-snapshot}.log`。不启动应用窗口，无前端/DTO/IPC或资源变动，不重复前端构建。
