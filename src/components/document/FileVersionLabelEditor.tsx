import { useEffect, useId, useRef, useState } from "react";
import { Star } from "lucide-react";
import { Button } from "../../ui/components/Button";
import { TextField } from "../../ui/components/TextField";

export interface FileVersionLabelEditorProps {
  version: { id: string; versionNumber: number; displayName: string | null; isImportant: boolean };
  onSave: (input: { displayName: string | null; isImportant: boolean }) => Promise<void>;
  disabled?: boolean;
}

export function FileVersionLabelEditor(props: FileVersionLabelEditorProps) {
  return <VersionLabelForm key={props.version.id} {...props} />;
}

function VersionLabelForm({ version, onSave, disabled = false }: FileVersionLabelEditorProps) {
  const [name, setName] = useState(version.displayName ?? "");
  const [confirmedName, setConfirmedName] = useState(version.displayName);
  const [important, setImportant] = useState(version.isImportant);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const saving = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const inputId = useId();
  const errorId = useId();
  const blocked = disabled || pending;

  async function save() {
    if (disabled || saving.current) return;
    setSaved(false);
    if (/\p{Cc}/u.test(name)) {
      setError("名称不能包含控制字符。");
      return;
    }
    const normalized = name.trim();
    if (Array.from(normalized).length > 200) {
      setError("名称最多 200 个 Unicode 字符。");
      return;
    }
    const input = { displayName: normalized || null, isImportant: important };
    // Capture this version's callback before crossing the asynchronous boundary.
    const saveVersion = onSave;
    saving.current = true;
    setPending(true);
    setError(undefined);
    try {
      await saveVersion(input);
      if (active.current) {
        setName(input.displayName ?? "");
        setConfirmedName(input.displayName);
        setSaved(true);
      }
    } catch (cause) {
      if (active.current) {
        const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
        setError(message.trim() ? message : "保存失败，请重试。");
      }
    } finally {
      saving.current = false;
      if (active.current) setPending(false);
    }
  }
  return <div className="grid gap-3" aria-busy={pending}>
    <p className="text-body font-medium text-text">V{version.versionNumber}{confirmedName ? `（${confirmedName}）` : ""}</p>
    <label htmlFor={inputId} className="text-ui text-text-muted">自定义版本名称</label>
    <TextField id={inputId} value={name} onChange={event => { setName(event.target.value); setSaved(false); setError(undefined); }} disabled={blocked} aria-invalid={!!error} aria-describedby={error ? errorId : undefined} />
    <label className="flex items-center gap-2 text-body text-text">
      <input type="checkbox" checked={important} onChange={event => { setImportant(event.target.checked); setSaved(false); }} disabled={blocked} />
      <Star size={14} aria-hidden="true" fill={important ? "currentColor" : "none"} />
      重要版本
    </label>
    {error ? <p id={errorId} role="alert" className="text-body text-danger">{error}</p> : null}
    {saved ? <p role="status" className="text-ui text-text-muted">已保存</p> : null}
    <Button type="button" disabled={blocked} onClick={() => void save()}>{pending ? "保存中…" : "保存"}</Button>
  </div>;
}
