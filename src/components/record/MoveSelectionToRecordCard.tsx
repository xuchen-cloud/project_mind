import { useMemo, useState } from "react";
import { FilePlus2, NotebookPen, X } from "lucide-react";

import { formatDateTime } from "../../lib/formatters";
import { Button, IconButton, PopoverPanel, SearchField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";

export interface MoveSelectionRecordOption {
  id: number;
  title?: string | null;
  contentMarkdown: string;
  updatedAt: string;
}

interface MoveSelectionToRecordCardProps<TRecord extends MoveSelectionRecordOption> {
  records: TRecord[];
  onClose: () => void;
  onSelectRecord: (record: TRecord) => Promise<unknown>;
  onCreateRecord: (title?: string) => Promise<unknown>;
}

export function MoveSelectionToRecordCard<TRecord extends MoveSelectionRecordOption>({
  records,
  onClose,
  onSelectRecord,
  onCreateRecord,
}: MoveSelectionToRecordCardProps<TRecord>) {
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLocaleLowerCase("zh-Hans-CN");
  const recentRecords = useMemo(
    () =>
      [...records]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 6),
    [records],
  );
  const matchingRecords = useMemo(() => {
    if (!normalizedQuery) {
      return recentRecords;
    }

    return records
      .filter((record) => {
        const title = record.title ?? "";
        return (
          title.toLocaleLowerCase("zh-Hans-CN").includes(normalizedQuery) ||
          record.contentMarkdown.toLocaleLowerCase("zh-Hans-CN").includes(normalizedQuery)
        );
      })
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 8);
  }, [normalizedQuery, recentRecords, records]);

  async function runAction(key: string, action: () => Promise<unknown>) {
    if (busyKey) {
      return;
    }

    setBusyKey(key);
    try {
      await action();
      onClose();
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-start justify-center bg-[rgba(16,20,24,0.22)] px-4 pt-[12vh]">
      <PopoverPanel className="w-[min(34rem,calc(100vw-2rem))] p-3 shadow-[var(--shadow-lg)]">
        <div className="mb-2 flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <NotebookPen size={15} className="text-accent" />
            <h2 className="truncate text-[13px] font-semibold text-text">移动到记录</h2>
          </div>
          <IconButton
            type="button"
            size="sm"
            variant="ghost"
            aria-label="关闭移动到记录"
            onClick={onClose}
          >
            <X size={14} />
          </IconButton>
        </div>

        <SearchField
          autoFocus
          value={query}
          placeholder="搜索记录，或输入标题创建"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />

        <div className="mt-3 max-h-[18rem] overflow-y-auto">
          {matchingRecords.length > 0 ? (
            <div className="grid gap-1">
              <p className="px-1 text-[11px] font-medium text-text-soft">
                {normalizedQuery ? "匹配记录" : "最近更新"}
              </p>
              {matchingRecords.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  className={cn(
                    "w-full rounded-[var(--radius-6)] px-2.5 py-2 text-left outline-none transition-colors",
                    "hover:bg-bg-hover focus-visible:bg-bg-hover disabled:cursor-wait disabled:text-text-disabled",
                  )}
                  disabled={busyKey !== null}
                  onClick={() =>
                    void runAction(`record-${record.id}`, () => onSelectRecord(record))
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-[13px] font-medium text-text">
                      {record.title?.trim() || firstContentLine(record.contentMarkdown) || "未命名记录"}
                    </span>
                    <span className="shrink-0 text-[11px] text-text-soft">
                      {formatDateTime(record.updatedAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-text-soft">
                    {firstContentLine(record.contentMarkdown) || "暂无正文"}
                  </p>
                </button>
              ))}
            </div>
          ) : (
            <p className="px-1 py-4 text-center text-ui text-text-soft">没有匹配的记录。</p>
          )}
        </div>

        <div className="mt-3 flex justify-end border-t border-border pt-3">
          <Button
            type="button"
            size="sm"
            variant="primary"
            leadingIcon={<FilePlus2 size={14} />}
            disabled={busyKey !== null}
            onClick={() =>
              void runAction("create", () =>
                onCreateRecord(trimmedQuery ? trimmedQuery : undefined),
              )
            }
          >
            {trimmedQuery ? `创建记录：${trimmedQuery}` : "创建无标题记录"}
          </Button>
        </div>
      </PopoverPanel>
    </div>
  );
}

function firstContentLine(markdown: string) {
  return markdown
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find(Boolean);
}
