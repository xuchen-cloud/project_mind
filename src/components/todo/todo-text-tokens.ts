export interface TodoTextTriggerRange {
  start: number;
  end: number;
}

export function replaceTodoTextTrigger(
  source: string,
  trigger: TodoTextTriggerRange,
  replacement: string,
) {
  const nextValue = source.slice(0, trigger.start) + replacement + source.slice(trigger.end);
  const nextSelection = trigger.start + replacement.length;

  return { nextValue, nextSelection };
}
