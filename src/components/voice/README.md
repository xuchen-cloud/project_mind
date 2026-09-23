# Voice Record UI skeleton

M1 双轨录音已经接入正式页面：当前项目或 Workspace 可直接开始录音，底部控制条提供暂停、继续和结束。

后续接线顺序：

1. `VoiceSettingsPanel` 已接入 SettingsDialog，并持久化 workspace 级配置。
2. `VoiceFloatingPanel` 已接入主界面，创建 Voice Record 后定位对应 Record。
3. `VoiceRecordPanel` 已接入两种 Record 焦点页：以单一控制条同步混合底层双轨，支持播放、暂停、拖动和倍速；保持现有富文本编辑器独立。
4. 后续可将 `VoiceFloatingPanel` 拆为独立 Tauri entry/window；后端已经持有唯一会话。
5. 后端事件 → 前端轻量状态镜像；刷新/漏事件后读取 snapshot，不能在每个窗口各建一个录音引擎。
6. 退出、更新重启和 Workspace 切换 → 现有保存屏障加语音结束保存步骤。

录音、双轨持久化、暂停/继续/结束、异常恢复和统一回放 API 已实现。模型下载、字幕和 AI 处理仍待后续里程碑。
