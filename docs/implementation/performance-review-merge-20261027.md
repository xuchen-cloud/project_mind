# 性能修复双轴审查与合并记录

## 审查基点与范围

用户要求“双轴检视然后合并到develop”，并明确要求使用两个子agent。固定基点 `5de9a91692136d378fd4595716109bf7c25e4d22`（2026-10-27重新fetch的origin/develop），原修复提交 `af8f89597f63816e963282bc6ab78a8e0a465cc1`。审查命令 `git diff 5de9a91...af8f895`，164文件；仅此一个原实现提交。

Standards与Spec分别由独立子agent执行，主agent负责核实、整改决策、验证整合与发布。审查输入包括AGENTS、CONTEXT、ADR-0003/0006/0007/0008/0009、两份性能审计及历史review复核。验证记录详见[修复执行记录](performance-review-fixes-20261027.md)。不重跑未受影响的已通过检查，不将缺少特定平台环境虚构成代码缺陷。

## Standards 初审

1项P2阻塞：目录首次读取或焦点刷新在途时发生文件变更，`cancelRefetch:false`复用旧查询，脏标记提前消耗。旧数据返回后失效状态被清除，配合`staleTime:Infinity`及移除轮询，列表可能持续陈旧。违反AGENTS关于跨异步后复核真实不变量与在本包修复正确性问题的要求。审查者用真实TanStack Query最小实验确认：1次请求、旧数据、`isInvalidated=false`。

没有确认其它硬性标准违规；风格smell不是独立发布门槛，也不代表逐路径穷尽证明。

## Spec 初审

2项P2阻塞，分别对应实际规格：

1. 同一目录失效竞态。违反首轮审计“订阅变更并合并失效”，与Standards发现合并处理。
2. VoiceRecordPanel录音结束、纪要ready、恢复为空或ready后，minutes/recovery仍各5秒轮询，约每分钟24次请求。违反首轮审计“隐藏页、无录制和终态明确停更条件”。

Office隐藏恢复实机、CPU/RSS/p95没有新的完整量化证据，归为验收边界，不虚构成已证实实现故障。Windows/Linux、硬件录音等边界沿用原记录。

## 整改工作包

关联：[整改Issue #273](https://github.com/xuchen-cloud/project_mind/issues/273)、首轮目录事件刷新及语音终态停更；不关闭范围更大的父功能Issue。

- 目录：仅修改ProjectDirectoryBrowser及对应测试，等待事件之前已开始的匹配读取完成后补查，保留脏路径合并、隐藏不读、scope隔离及单分支刷新。非目标：重新引入轮询、修改原生目录协议。先复现initial/focus在途竞态，定向验证目录/HomeProjectFiles与类型检查。
- 语音：仅修改VoiceRecordPanel及对应测试，终态停止周期读取；保留pending/running观察、手动生成/重试、录制结束和恢复完成唤醒。非目标：改变原始转写/音轨、重新引入常驻heartbeat。先用假时钟及真实Query复现，定向验证VoiceRecordPanel及受影响语音组件、类型检查。

范围明确的实现交给6.1 sol；审查者独立保留，修复后回到原审查者复核。未通过两轴复核前不合并。

## 最终验证与审查结果

- 目录第一轮修复native dirty路径后，Standards复核仍发现documents/focus绕过队列。已统一三入口，不把仅原生事件路径通过当作整体通过。新增真实QueryClient/deferred回归覆盖initial/focus旧快照、documents在途变更、混合事件合并、hidden恢复、unmount/scope隔离。初轮2个红例、补齐入口8个红例已转绿；最终ProjectDirectoryBrowser + HomeProjectFiles **38/38通过**。
- 语音补齐终态停更，并按原生真实enqueue路径唤醒。主agent追加确认自动wake及手动generate初始无data在途也可吞掉新任务，统一等待旧请求settle后补读，清理目标/卸载后的排队操作。首轮面板 **52/52通过**，后续补齐下述复核时序后最终 **63/63通过**；相关Voice组件与播放器 **74/74通过**，后续manual入口修正不影响其代码。终态一分钟无增长，pending/running继续观察直到完成。
- 两个实现包各自类型检查与diff检查通过；主agent最终Vite构建、UI标准、bundle边界通过（主入口222KiB/250KiB）。临时日志名为 `mind-merge-vite.log`、`mind-merge-ui-standards.log`、`mind-merge-bundle.log`。
- 本轮不改Rust、格式引擎或跨端DTO，复用原提交的完整Rust、Office、DSH与未受影响前端验证。未启动可见应用窗口。

本轮定向命令（均在仓库根，最终退出码0；保留子agent工具输出，未另存日志）：

```sh
node node_modules/vitest/vitest.mjs run src/components/home/ProjectDirectoryBrowser.test.tsx src/components/home/HomeProjectFiles.test.tsx
npx vitest run src/components/voice/VoiceRecordPanel.test.tsx --maxWorkers=1
npx vitest run src/components/voice/VoiceCaptionWindow.test.tsx src/components/voice/VoiceSettingsPanel.test.tsx src/components/voice/VoiceFloatingPanel.test.tsx src/components/voice/voice-live-poll.test.ts src/services/voiceApi.test.ts src/services/voiceWindowPosition.test.ts src/lib/voice-window-position.test.ts src/lib/voice-player.test.ts --maxWorkers=1
npx tsc --noEmit
```

## 后续复核发现

目录项经两轴复核已关闭；语音复核又定位了两条确定的时序缺口：

- Standards：结束补读正在等待旧请求时隐藏，再于旧请求完成前返回，旧生命周期已撤销但新生命周期没有承接补读意图。旧ready/null返回后可能永久保留旧纪要。
- Spec：首次recovery返回ready之前，minutes已读到旧ready；首次恢复观测没有唤醒纪要，两个终态查询均停止。审查者通过真实组件及QueryClient独立复现一次minutes读取后停更。

两项均已修复，并补齐主agent确认的同根因首开竞态：minutes先返回旧ready，首次playback随后返回ended，原先没有recording→ended观测也会漏读。

最终实现以目标作用域持有有界dirty集合和每key一个在途任务，等待真实Query promise结束后补读。隐藏只暂停消费、保留意图；恢复由当前生命周期承接；切换目标/卸载清理，generation隔离StrictMode旧任务。首次ended按session唤醒一次，首次recovery ready或已有提交进度补读纪要；手动操作也使用同一队列。回归覆盖两种响应先后、隐藏往返、隐藏期间手动完成、单在途、scope和StrictMode。最终面板63/63、类型检查、diff通过。

因生产代码在首轮构建后变化，重新执行Vite构建和UI/bundle检查；目录、Rust、Office、DSH及74项不受影响语音关联验证继续复用。最终Vite构建3.45秒通过，UI标准和bundle边界通过（222KiB/250KiB）。

## 最终双轴结论

- **Standards：通过，未关闭0项。** 目录与语音P2均关闭；确认跨异步等待、隐藏保留、目标/generation隔离、单在途及错误展示符合仓库规则。
- **Spec：通过，未关闭0项。** 目录项、语音终态轮询及关联漏唤醒问题均关闭；确认初次观测和自动/手动事件均能有界补读，且隐藏与卸载约束保留。

两个审查者均只读复核最终实现及回归断言，未重复执行测试；测试与最终构建结果由实现agent和主agent提供。此结论不扩大Office实机、Windows/Linux、硬件或CPU/RSS/p95的原验证边界。

已满足本仓库发布门槛；此记录与最终代码一并提交，按Issue #273创建以develop为base的PR并合并。合并结果以GitHub PR和Issue状态为准。
