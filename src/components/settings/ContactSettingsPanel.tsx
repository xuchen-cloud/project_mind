import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Trash2, UserRound } from "lucide-react";

import { deriveContactPinyin } from "../../lib/pinyin";
import type { ContactRecord, ContactUpsertInput } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import {
  Button,
  EmptyState,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
  TextField,
} from "../../ui/components";

interface ContactSettingsPanelProps {
  open: boolean;
}

interface ContactDraft {
  name: string;
  email: string;
  employeeId: string;
  role: string;
  department: string;
}

const EMPTY_DRAFT: ContactDraft = {
  name: "",
  email: "",
  employeeId: "",
  role: "",
  department: "",
};

function draftToUpsertInput(draft: ContactDraft, id?: number): ContactUpsertInput {
  const name = draft.name.trim();
  const pinyin = deriveContactPinyin(name);

  return {
    id,
    name,
    pinyinFull: pinyin.pinyinFull,
    pinyinAbbr: pinyin.pinyinAbbr,
    email: draft.email.trim(),
    employeeId: draft.employeeId.trim(),
    role: draft.role.trim(),
    department: draft.department.trim(),
  };
}

export function ContactSettingsPanel({ open }: ContactSettingsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const contactsQuery = useQuery({
    queryKey: ["contacts", "all"],
    queryFn: projectMindApi.contactList,
    enabled: open,
  });

  const contacts = contactsQuery.data;
  const [createComposerOpen, setCreateComposerOpen] = useState(false);
  const [newDraft, setNewDraft] = useState<ContactDraft>(EMPTY_DRAFT);

  const refreshViews = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["contacts"] });
  }, [queryClient]);

  const upsertMutation = useMutation({
    mutationFn: projectMindApi.contactUpsert,
    onSuccess: async (_contact, variables) => {
      if (!variables.id) {
        setStatus({ tone: "success", label: "Created", message: "联系人已新增" });
        setNewDraft(EMPTY_DRAFT);
        setCreateComposerOpen(false);
      }
      await refreshViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "保存联系人失败" });
      pushToast({ tone: "error", title: "保存联系人失败", detail: String(error) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: projectMindApi.contactDelete,
    onSuccess: async () => {
      setStatus({ tone: "success", label: "Deleted", message: "联系人已删除" });
      await refreshViews();
    },
    onError: (error) => {
      setStatus({ tone: "error", label: "Error", message: "删除联系人失败" });
      pushToast({ tone: "error", title: "删除联系人失败", detail: String(error) });
    },
  });

  const saveContact = useCallback(
    (input: ContactUpsertInput) => upsertMutation.mutateAsync(input),
    [upsertMutation],
  );

  const summary = useMemo(
    () => ({
      contactCount: contacts?.length ?? 0,
      withEmailCount: contacts?.filter((contact) => contact.email.trim().length > 0).length ?? 0,
    }),
    [contacts],
  );

  if (contactsQuery.isLoading && !contacts) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center gap-2 text-body text-text-soft">
        <LoaderCircle className="spin" size={16} />
        正在加载联系人...
      </div>
    );
  }

  if (contactsQuery.isError || !contacts) {
    return (
      <div className="flex min-h-[32rem] items-center justify-center">
        <EmptyState
          title="联系人暂时不可用"
          text="读取联系人列表失败。可以重试一次，或稍后再打开。"
          action={
            <Button type="button" variant="secondary" onClick={() => contactsQuery.refetch()}>
              重新加载
            </Button>
          }
          className="w-full max-w-lg"
        />
      </div>
    );
  }

  const canSubmitNew = newDraft.name.trim().length > 0 && !upsertMutation.isPending;

  return (
    <div className="grid gap-4">
      <SurfaceCard subtle className="px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
              Contacts
            </p>
            <p className="mt-1 text-body text-text-muted">
              维护 workspace 联系人。笔记 / Todo 中输入 @ 可按姓名、拼音搜索并提及。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="neutral">{summary.contactCount} 位联系人</StatusBadge>
            <StatusBadge tone={summary.withEmailCount > 0 ? "accent" : "neutral"}>
              {summary.withEmailCount} 个含邮箱
            </StatusBadge>
          </div>
        </div>
      </SurfaceCard>

      <SurfaceCard subtle className="grid gap-4 p-4">
        <SectionHeader
          eyebrow="Directory"
          title="联系人"
          actions={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              leadingIcon={<Plus size={14} />}
              onClick={() =>
                setCreateComposerOpen((current) => {
                  const nextOpen = !current;
                  if (!nextOpen) {
                    setNewDraft(EMPTY_DRAFT);
                  }
                  return nextOpen;
                })
              }
            >
              新建联系人
            </Button>
          }
        />

        {createComposerOpen ? (
          <ContactComposer
            draft={newDraft}
            busy={upsertMutation.isPending}
            canSubmit={canSubmitNew}
            onChange={setNewDraft}
            onCancel={() => {
              setCreateComposerOpen(false);
              setNewDraft(EMPTY_DRAFT);
            }}
            onSubmit={() => saveContact(draftToUpsertInput(newDraft))}
          />
        ) : null}

        <div className="grid gap-3">
          {contacts.length > 0 ? (
            contacts.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                busy={upsertMutation.isPending || deleteMutation.isPending}
                onSave={saveContact}
                onDelete={() => {
                  const confirmed =
                    typeof window === "undefined"
                      ? true
                      : window.confirm(`删除联系人“${contact.name}”后无法恢复。确定继续吗？`);
                  if (!confirmed) {
                    return;
                  }
                  deleteMutation.mutate({ contactId: contact.id });
                }}
              />
            ))
          ) : (
            <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-5 text-body text-text-soft">
              还没有联系人。先创建几位常用联系人，或在笔记里输入 @ 边写边建档。
            </p>
          )}
        </div>
      </SurfaceCard>
    </div>
  );
}

function ContactRow({
  contact,
  busy,
  onSave,
  onDelete,
}: {
  contact: ContactRecord;
  busy: boolean;
  onSave: (input: ContactUpsertInput) => Promise<unknown>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ContactDraft>(() => contactToDraft(contact));
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraft(contactToDraft(contact));
    setEditing(false);
  }, [contact]);

  const cancelEdit = useCallback(() => {
    setDraft(contactToDraft(contact));
    setEditing(false);
  }, [contact]);

  const commit = useCallback(() => {
    if (!draft.name.trim()) {
      cancelEdit();
      return;
    }

    void onSave(draftToUpsertInput(draft, contact.id)).catch(() => undefined);
    setEditing(false);
  }, [cancelEdit, contact.id, draft, onSave]);

  if (editing) {
    return (
      <div
        ref={rootRef}
        className="grid gap-2 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3"
      >
        <ContactFields draft={draft} busy={busy} onChange={setDraft} />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancelEdit}>
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            variant="danger"
            leadingIcon={<Trash2 size={14} />}
            disabled={busy}
            onClick={onDelete}
          >
            删除
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || !draft.name.trim()}
            onClick={commit}
          >
            保存
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-2.5">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-6)] bg-transparent py-1 text-left transition-colors hover:text-text-soft"
        disabled={busy}
        onClick={() => setEditing(true)}
      >
        <span className="shrink-0 text-accent">
          <UserRound size={15} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body text-text">{contact.name}</span>
          <span className="block truncate text-caption text-text-soft">
            {buildContactSubtitle(contact)}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
          编辑
        </Button>
        <Button
          type="button"
          size="sm"
          variant="danger"
          leadingIcon={<Trash2 size={14} />}
          disabled={busy}
          onClick={onDelete}
        >
          删除
        </Button>
      </div>
    </div>
  );
}

function ContactComposer({
  draft,
  busy,
  canSubmit,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: ContactDraft;
  busy: boolean;
  canSubmit: boolean;
  onChange: (draft: ContactDraft) => void;
  onCancel: () => void;
  onSubmit: () => Promise<unknown>;
}) {
  return (
    <div className="grid gap-2 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3">
      <ContactFields draft={draft} busy={busy} autoFocus onChange={onChange} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!canSubmit}
          onClick={() => {
            void onSubmit().catch(() => undefined);
          }}
        >
          创建联系人
        </Button>
      </div>
    </div>
  );
}

function ContactFields({
  draft,
  busy,
  autoFocus = false,
  onChange,
}: {
  draft: ContactDraft;
  busy: boolean;
  autoFocus?: boolean;
  onChange: (draft: ContactDraft) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <TextField
        autoFocus={autoFocus}
        fieldSize="sm"
        value={draft.name}
        disabled={busy}
        placeholder="姓名（必填）"
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />
      <TextField
        fieldSize="sm"
        value={draft.email}
        disabled={busy}
        placeholder="邮箱"
        onChange={(event) => onChange({ ...draft, email: event.target.value })}
      />
      <TextField
        fieldSize="sm"
        value={draft.employeeId}
        disabled={busy}
        placeholder="工号"
        onChange={(event) => onChange({ ...draft, employeeId: event.target.value })}
      />
      <TextField
        fieldSize="sm"
        value={draft.role}
        disabled={busy}
        placeholder="角色"
        onChange={(event) => onChange({ ...draft, role: event.target.value })}
      />
      <TextField
        fieldSize="sm"
        value={draft.department}
        disabled={busy}
        placeholder="部门"
        onChange={(event) => onChange({ ...draft, department: event.target.value })}
        className="sm:col-span-2"
      />
    </div>
  );
}

function contactToDraft(contact: ContactRecord): ContactDraft {
  return {
    name: contact.name,
    email: contact.email,
    employeeId: contact.employeeId,
    role: contact.role,
    department: contact.department,
  };
}

function buildContactSubtitle(contact: ContactRecord) {
  const parts = [contact.role, contact.department, contact.email, contact.employeeId].filter(
    (part) => part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : "暂无更多信息";
}
