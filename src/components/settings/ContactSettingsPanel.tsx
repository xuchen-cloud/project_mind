import { useCallback, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Trash2, UserRound } from "lucide-react";

import { deriveContactNicknamePinyin, deriveContactPinyin } from "../../lib/pinyin";
import { getErrorMessage } from "../../lib/errors";
import { queryKeys } from "../../lib/queryKeys";
import type { ContactRecord, ContactUpsertInput } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { HomeSidebarList } from "../home/HomeSidebarList";
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
  nicknames: string;
  notes: string;
  email: string;
  employeeId: string;
  role: string;
  department: string;
}

const EMPTY_DRAFT: ContactDraft = {
  name: "",
  nicknames: "",
  notes: "",
  email: "",
  employeeId: "",
  role: "",
  department: "",
};

function draftToUpsertInput(draft: ContactDraft, id?: number, baseRevision?: number): ContactUpsertInput {
  const name = draft.name.trim();
  const pinyin = deriveContactPinyin(name);

  return {
    id,
    ...(baseRevision !== undefined ? { baseRevision } : {}),
    name,
    nicknames: draft.nicknames,
    nicknamePinyin: deriveContactNicknamePinyin(draft.nicknames),
    notes: draft.notes,
    pinyinFull: pinyin.pinyinFull,
    pinyinAbbr: pinyin.pinyinAbbr,
    email: draft.email.trim(),
    employeeId: draft.employeeId.trim(),
    role: draft.role.trim(),
    department: draft.department.trim(),
  };
}

function isContactRevisionConflict(error: unknown) {
  return getErrorMessage(error).startsWith("REVISION_CONFLICT:");
}

export function ContactSettingsPanel({ open }: ContactSettingsPanelProps) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const [query, setQuery] = useState("");
  const searchQuery = query.trim();
  const contactsQuery = useQuery({
    queryKey: [...queryKeys.contacts.all, searchQuery ? "search" : "all", ...(searchQuery ? [searchQuery] : [])],
    queryFn: () => searchQuery ? projectMindApi.contactSearch({ query: searchQuery, limit: 100 }) : projectMindApi.contactList(),
    enabled: open,
  });

  const contacts = contactsQuery.data;
  // A remote rename can remove a contact from the current search. Keep rows
  // with open drafts mounted until the user saves or cancels them explicitly.
  const [editingContacts, setEditingContacts] = useState<Map<number, ContactRecord>>(() => new Map());
  const visibleContacts = useMemo(() => {
    const result = new Map((contacts ?? []).map((contact) => [contact.id, contact]));
    for (const [id, contact] of editingContacts) if (!result.has(id)) result.set(id, contact);
    return [...result.values()];
  }, [contacts, editingContacts]);
  const releaseContact = (id: number) => setEditingContacts((current) => {
    const next = new Map(current); next.delete(id); return next;
  });
  const [createComposerOpen, setCreateComposerOpen] = useState(false);
  const [newDraft, setNewDraft] = useState<ContactDraft>(EMPTY_DRAFT);

  const refreshViews = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.searchAll }),
    ]);
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
      const conflict = isContactRevisionConflict(error);
      const title = conflict ? "联系人已被修改" : "保存联系人失败";
      setStatus({ tone: "error", label: conflict ? "Conflict" : "Error", message: title });
      pushToast({ tone: "error", title, detail: conflict ? "其他窗口或 CLI 已修改联系人。草稿已保留，请重新读取最新资料并核对。" : getErrorMessage(error) });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: projectMindApi.contactDelete,
    onSuccess: async (_deleted, variables) => {
      releaseContact(variables.contactId);
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

  const reloadContact = async (id: number) => {
    try {
      const all = await queryClient.fetchQuery({ queryKey: [...queryKeys.contacts.all, "all"], queryFn: projectMindApi.contactList, staleTime: 0 });
      const latest = all.find((contact) => contact.id === id);
      if (!latest) throw new Error("联系人已被删除，当前草稿仍已保留。请复制需要保留的内容后取消编辑。");
      setEditingContacts((current) => new Map(current).set(id, latest));
      if (searchQuery) await contactsQuery.refetch({ throwOnError: true });
    } catch (error) {
      setStatus({ tone: "error", label: "Error", message: "重新读取联系人失败" });
      pushToast({ tone: "error", title: "重新读取联系人失败", detail: getErrorMessage(error) });
      throw error;
    }
  };

  const summary = useMemo(
    () => ({
      contactCount: contacts?.length ?? 0,
      withEmailCount: contacts?.filter((contact) => contact.email.trim().length > 0).length ?? 0,
    }),
    [contacts],
  );

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
              维护工作区联系人。姓名、昵称支持全拼和首字母搜索，也可搜索工号、邮箱、部门、备注，或在笔记 / Todo 中输入 @ 提及。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="neutral">{searchQuery ? "匹配 " : ""}{summary.contactCount} 位联系人</StatusBadge>
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

        <TextField type="search" aria-label="搜索联系人" placeholder="搜索姓名、昵称、拼音、工号、邮箱、部门、备注（支持多个关键词）"
          value={query} onChange={(event) => setQuery(event.target.value)} />

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

        {contactsQuery.isLoading ? <div role="status" className="flex items-center gap-2 py-4 text-body text-text-soft">
          <LoaderCircle className="spin" size={16} />{searchQuery ? "正在搜索联系人..." : "正在加载联系人..."}
        </div> : contactsQuery.isError ? <EmptyState title="联系人暂时不可用" text={searchQuery ? "搜索联系人失败，请重试。" : "读取联系人列表失败，请重试。"}
          action={<Button type="button" variant="secondary" onClick={() => contactsQuery.refetch()}>重新加载</Button>} /> : null}
        <div className="flex max-h-[min(32rem,60vh)] min-h-0 flex-col [--home-sidebar:var(--color-bg-subtle)]">
          <HomeSidebarList label="联系人列表" searchKey={searchQuery} variant="todo">
          <div className="grid gap-3">
          {visibleContacts.length > 0 ? (
            visibleContacts.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                busy={upsertMutation.isPending || deleteMutation.isPending}
                onSave={saveContact}
                onEditStart={() => setEditingContacts((current) => new Map(current).set(contact.id, contact))}
                onEditEnd={() => releaseContact(contact.id)}
                onReload={() => reloadContact(contact.id)}
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
          ) : !contactsQuery.isLoading && !contactsQuery.isError ? (
            <p className="rounded-[var(--radius-8)] border border-dashed border-border px-3 py-5 text-body text-text-soft">
              {searchQuery ? "没有匹配的联系人。试试其他关键词，或新建联系人。" : "还没有联系人。先创建几位常用联系人，或在笔记里输入 @ 边写边建档。"}
            </p>
          ) : null}
          </div>
          </HomeSidebarList>
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
  onEditStart,
  onEditEnd,
  onReload,
}: {
  contact: ContactRecord;
  busy: boolean;
  onSave: (input: ContactUpsertInput) => Promise<unknown>;
  onDelete: () => void;
  onEditStart: () => void;
  onEditEnd: () => void;
  onReload: () => Promise<void>;
}) {
  // A draft and its CAS revision are one snapshot. Query refreshes must never
  // pair an existing draft with the revision of a different committed contact.
  const [edit, setEdit] = useState<{ draft: ContactDraft; baseRevision: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const startEdit = () => {
    setEdit({ draft: contactToDraft(contact), baseRevision: contact.revision });
    setConflict(false);
    onEditStart();
  };
  const cancelEdit = useCallback(() => { setEdit(null); setConflict(false); onEditEnd(); }, [onEditEnd]);

  const commit = useCallback(() => {
    if (!edit) return;
    if (!edit.draft.name.trim()) {
      cancelEdit();
      return;
    }

    void onSave(draftToUpsertInput(edit.draft, contact.id, edit.baseRevision)).then(cancelEdit).catch((error) => {
      if (isContactRevisionConflict(error)) setConflict(true);
    });
  }, [cancelEdit, contact.id, edit, onSave]);

  if (edit) {
    return (
      <div
        className="grid gap-2 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3"
      >
        <ContactFields draft={edit.draft} busy={busy} onChange={(draft) => setEdit((current) => current ? { ...current, draft } : null)} />
        {conflict || contact.revision !== edit.baseRevision ? <div className="grid gap-2 rounded-[var(--radius-6)] border border-border bg-bg-subtle p-3">
          <p role="alert" className="text-body text-text-muted">联系人已被其他窗口或 CLI 修改，草稿已保留。请重新读取并核对最新资料；如需采用最新资料，请取消后重新编辑。</p>
          <Button type="button" size="sm" variant="secondary" disabled={busy || reloading} onClick={() => {
            setReloading(true);
            void onReload().catch(() => undefined).finally(() => setReloading(false));
          }}>{reloading ? "正在重新读取..." : "重新读取最新资料"}</Button>
          {contact.revision !== edit.baseRevision ? <div role="group" aria-label="最新联系人资料" className="grid gap-2">
            <p className="text-caption text-text-soft">最新资料（版本 {contact.revision}）；上方仍为你的草稿（版本 {edit.baseRevision}）。</p>
            <dl className="grid gap-1 text-body">{([
              ["姓名", contact.name], ["昵称", contact.nicknames], ["备注", contact.notes], ["邮箱", contact.email],
              ["工号", contact.employeeId], ["角色", contact.role], ["部门", contact.department],
            ] as const).map(([label, value]) => <div key={label} className="grid gap-1 sm:grid-cols-[3rem_1fr]">
              <dt className="text-text-soft">{label}</dt><dd className="whitespace-pre-wrap break-words text-text">{value || "未填写"}</dd>
            </div>)}</dl>
          </div> : null}
        </div> : null}
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
            disabled={busy || reloading || !edit.draft.name.trim()}
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
        onClick={startEdit}
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
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={startEdit}>
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
  const fieldId = useId();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <TextField
        autoFocus={autoFocus}
        fieldSize="sm"
        value={draft.name}
        disabled={busy}
        placeholder="姓名（必填）"
        aria-label="姓名"
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />
      <TextField
        fieldSize="sm"
        value={draft.email}
        disabled={busy}
        placeholder="邮箱"
        aria-label="邮箱"
        onChange={(event) => onChange({ ...draft, email: event.target.value })}
      />
      <TextField
        fieldSize="sm"
        value={draft.employeeId}
        disabled={busy}
        placeholder="工号"
        aria-label="工号"
        onChange={(event) => onChange({ ...draft, employeeId: event.target.value })}
      />
      <TextField
        fieldSize="sm"
        value={draft.role}
        disabled={busy}
        placeholder="角色"
        aria-label="角色"
        onChange={(event) => onChange({ ...draft, role: event.target.value })}
      />
      <TextField
        fieldSize="sm"
        value={draft.department}
        disabled={busy}
        placeholder="部门"
        aria-label="部门"
        onChange={(event) => onChange({ ...draft, department: event.target.value })}
        className="sm:col-span-2"
      />
      <div className="grid gap-1 sm:col-span-2">
        <label htmlFor={`${fieldId}-nicknames`} className="text-caption text-text-muted">昵称</label>
        <TextField id={`${fieldId}-nicknames`} fieldSize="sm" value={draft.nicknames} disabled={busy}
          aria-describedby={`${fieldId}-nicknames-help`} placeholder="例如：老王;William"
          onChange={(event) => onChange({ ...draft, nicknames: event.target.value })} />
        <p id={`${fieldId}-nicknames-help`} className="text-caption text-text-soft">多个昵称用分号 ; 分隔，也支持中文分号；逗号和 | 会保留在昵称中。</p>
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <label htmlFor={`${fieldId}-notes`} className="text-caption text-text-muted">备注</label>
        <textarea id={`${fieldId}-notes`} rows={3} value={draft.notes} disabled={busy} placeholder="补充合作背景、联系偏好等信息"
          className="w-full resize-y rounded-[var(--radius-6)] border border-border bg-bg px-2.5 py-2 text-ui text-text outline-none transition-[border-color,box-shadow] placeholder:text-text-soft hover:border-border-strong focus:border-accent"
          onChange={(event) => onChange({ ...draft, notes: event.target.value })} />
      </div>
    </div>
  );
}

function contactToDraft(contact: ContactRecord): ContactDraft {
  return {
    name: contact.name,
    nicknames: contact.nicknames,
    notes: contact.notes,
    email: contact.email,
    employeeId: contact.employeeId,
    role: contact.role,
    department: contact.department,
  };
}

function buildContactSubtitle(contact: ContactRecord) {
  const parts = [contact.nicknames, contact.role, contact.department, contact.email, contact.employeeId].filter(
    (part) => part.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : "暂无更多信息";
}
