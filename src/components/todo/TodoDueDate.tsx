import { CalendarDays } from "lucide-react";

import { formatFullDate, formatMonthDay } from "./todo-utils";

export function TodoDueDate({ value }: { value: string }) {
  const fullDate = formatFullDate(value);

  return (
    <time
      className="todo-due-date"
      dateTime={fullDate}
      title={`截止日期：${fullDate}`}
      aria-label={`截止日期 ${fullDate}`}
    >
      <CalendarDays className="todo-due-date__icon" size={11} aria-hidden="true" />
      <span>{formatMonthDay(value)}</span>
    </time>
  );
}
