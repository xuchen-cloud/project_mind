import { desktopApi } from "./desktopApi";

export interface DshScheduleRule {
  kind: "hours" | "days" | "weekdays" | "weeks" | "monthly";
  startDate: string;
  time: string;
  interval?: number;
  weekdays?: number[];
  dayOfMonth?: number;
}
export interface DshScheduledTaskInput {
  title: string;
  prompt: string;
  sessionId: string;
  enabled: boolean;
  rule: DshScheduleRule;
}
export interface DshScheduledTask extends DshScheduledTaskInput {
  id: string;
  timeZone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}
export const dshScheduleApi = {
  list: () => desktopApi.command<DshScheduledTask[]>("dsh_scheduled_tasks", { request: { operation: "list" } }),
  create: (task: DshScheduledTaskInput, requestId: string = crypto.randomUUID()) => desktopApi.command<DshScheduledTask>("dsh_scheduled_tasks", { request: { operation: "create", task, requestId } }),
  update: (id: string, task: DshScheduledTaskInput, requestId: string = crypto.randomUUID()) => desktopApi.command<DshScheduledTask>("dsh_scheduled_tasks", { request: { operation: "update", id, task, requestId } }),
  run: (id: string, requestId: string = crypto.randomUUID()) => desktopApi.command<DshScheduledTask>("dsh_scheduled_tasks", { request: { operation: "run", id, requestId } }),
  delete: (id: string, requestId: string = crypto.randomUUID()) => desktopApi.command<null>("dsh_scheduled_tasks", { request: { operation: "delete", id, requestId } }),
};
