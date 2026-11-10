# 构建告警清理验证

关联 #308 集成工作。这里区分源码编译诊断、第三方打包提示和真实验收；不将忽略测试或未运行的平台记为通过。

## 已验证的源码清理

- `2157586` 移除 34 个 TypeScript 未使用声明/import，并启用 `noUnusedLocals`、`noUnusedParameters`。XLSX 生成脚本同步修正，重新生成不会恢复无用声明；严格 tsc、生成一致性和 UI 规范已通过。
- `1d1c8ce` 将两个已经通过 App 静态页面依赖加载的助手函数改为直接导入，消除无效动态导入提示。67 个相关测试、tsc、shipping Vite、UI 规范和 bundle 边界检查通过；主入口 249 KiB，门限 250 KiB。具体日志见相邻 [File-flow 验证](../fileflows/README.md)。
- Rust 第一轮清理为 `ac5895f`、`84b203c`；后续助手集成清理为 `73a932c`（来源 `c54539d`）。删除确认没有调用者的内部成员，仅测试使用的旧适配器按 `cfg(test)` 编译；保留生产注册、迁移、序列化、读取与恢复协议。没有通过 `allow`、扩大可见性或忽略诊断实现清零。逐项调用者分析见 [清理审查](../../../../implementation/warning-cleanup-final-review.md)。

固定 `73a932ca3a18d7c228000513ec3a8706fa313f42` 的 macOS `cargo check --lib --offline` 和相关原生测试编译均为 **0 warnings**。实际测试结果 **722 passed、0 failed、18 ignored**；不是全仓库所有测试。命令按共享构建锁串行执行，`CARGO_INCREMENTAL=0`，共享可再生成 target，未启动窗口。`native-provenance.json` 保存 372 个 Rust/Cargo 文件指纹，运行期间无变化。

测试覆盖 agent/database、source session、overview，以及 File/Record 移动、编辑协调、目录变更、迁移和版本元数据。原 cleanup worker 的 609 passed / 1 failed / 10 ignored 是更早的真实失败样本，不能与 722 相加。单独运行的 3 个 prepared Record worker 测试也保留原始记录。

## 扩大验证发现的权限错误顺序

原基线 `cc99b73` 的 Record 测试失败已单独复现：解析未知 locator 先返回 NotFound，遮盖了 scope 拒绝。`4c85bbb` 前置 Workspace/request 校验，仅延迟可能由真实旧归属 alias 修正的 scope 拒绝；解析成功仍按实际 owner 与 allowlist 授权，IO 错误保持原样。新增 Record/Transcript/File 的 stale binding、越权未知定位符、授权未知定位符断言，目标红测失败后相关 24 个测试通过，最终纳入上述 722 通过结果。红测日志只证明运行到的首个失败断言，不声称每个分支都单独红过。

独立审查对这两文件增量未发现回归，但发现直接 File 写 caller 中既有的同类权限顺序缺口；该项仍由后续独立修复处理，不能据此宣称整体授权审查零发现。

## 打包提示与证据边界

本目录的 `shipping-vite-before-wavedrom.log` 是 `1d1c8ce` 的完整历史打包输出：仍有 WaveDrom 入口带入的两个 `eva.js` eval 提示，以及超过 900 kB 的 editor/adapters/PDF/vendor 块提示。WaveDrom 未使用入口正在单独收窄；没有提高体积门限或静默警告。源码编译告警清零不等于整个 shipping build 没有提示。

本报告不构成 Windows 编译或 WebView2 验收。原始 checkout 的 24 个文件哈希与暂存 diff 保持不变，见 `source-preservation.json`。归档文件来源和 SHA-256 见 `manifest.json`。Records/Office 最新增量仍须在其最终 head 上验证，#308 保持开放。
