import type { InputHTMLAttributes } from "react";

import { cn } from "../lib/cn";

type TextFieldSize = "sm" | "md";

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  fieldSize?: TextFieldSize;
}

export function TextField({ className, fieldSize = "md", ...props }: TextFieldProps) {
  return (
    <input
      className={cn(
        "w-full rounded-[var(--radius-6)] border border-border bg-bg px-3 text-body text-text outline-none transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] placeholder:text-text-soft hover:border-border-strong focus:border-accent",
        fieldSize === "sm" ? "h-7 px-2.5 text-ui" : "h-8",
        className,
      )}
      {...props}
    />
  );
}
