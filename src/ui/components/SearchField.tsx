import { forwardRef, type InputHTMLAttributes } from "react";
import { Search } from "lucide-react";

import { cn } from "../lib/cn";

interface SearchFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  loading?: boolean;
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { className, loading = false, ...props },
  ref,
) {
  return (
    <label
      className={cn(
        "flex h-8 items-center gap-2 rounded-[var(--radius-6)] border border-border bg-bg px-2.5 text-ui text-text-muted transition-[border-color,background-color] duration-[var(--duration-standard)] ease-[var(--ease-soft)] hover:border-border-strong focus-within:border-accent",
        className,
      )}
    >
      <Search size={14} className={loading ? "spin text-accent" : ""} />
      <input
        ref={ref}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-body text-text outline-none placeholder:text-text-soft"
        {...props}
      />
    </label>
  );
});
