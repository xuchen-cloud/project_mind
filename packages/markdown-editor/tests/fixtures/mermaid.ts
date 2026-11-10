export const flowchart = `flowchart TB
  A[收到客户反馈与会议纪要] --> B{是否已确认需求与验收标准}
  B -->|确认| C[负责人整理完整实施方案并安排跨团队评审]
  B -->|待补充| D[向相关方补充背景材料和中文长标签说明]
  D --> A
  C --> E[完成交付并沉淀到项目记录]`;

export const sequence = `sequenceDiagram
  participant Owner as 项目负责人
  participant Editor as 记录编辑器
  participant Store as 本地工作区
  Owner->>Editor: 编辑包含中文长标签的图表源码
  activate Editor
  Editor->>Store: 保存已确认正文与语言信息
  Store-->>Editor: 返回不可变版本
  deactivate Editor
  Note over Owner,Store: 重新打开后仍可查看图形和编辑原始源码
  Owner->>Editor: 导出项目记录`;

export const gantt = `gantt
  title 项目交付安排
  dateFormat YYYY-MM-DD
  section 实施
  确认方案 :a, 2026-11-10, 2d
  完成交付 :after a, 3d`;
export const invalid = 'flowchart LR\nA -->';
export const fenced = (source: string) => '```mermaid\n' + source + '\n```';

export const longSequence = sequence + '\n' + Array.from({ length: 24 }, (_, index) => `  Editor->>Store: 第 ${index + 1} 轮确认与长时序图保真验收`).join('\n');
