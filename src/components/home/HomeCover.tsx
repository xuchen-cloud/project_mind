import { useHomeModal } from "./useHomeModal";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BriefcaseBusiness, CalendarDays, Compass, FileText, House,
  Layers, Lightbulb, Pencil, Target, UsersRound, X,
} from "lucide-react";
import { useFeedbackStore } from "../../state/feedback-store";
import alpineCover from "../../assets/home/alpine-cover.jpg";
import forestCover from "../../assets/home/forest-cover.jpg";
import { readHomeIdentity, resizeHomeCover, writeHomeIdentity, type HomeIdentityValue } from "./homeIdentity";

const ICONS = {
  House, Compass, FileText, UsersRound, Lightbulb,
  Target, Layers, BriefcaseBusiness, CalendarDays,
} as const;

export function HomeIdentityIcon({ name, size = 34 }: { name: string; size?: number }) {
  const Icon = ICONS[name as keyof typeof ICONS] ?? Compass;
  return <Icon size={size} strokeWidth={1.8} />;
}

export function HomeCover({
  identityKey,
  defaultIcon,
  title,
  subtitle,
  canEditIcon = false,
}: {
  identityKey: string;
  defaultIcon: keyof typeof ICONS;
  title: ReactNode;
  subtitle: ReactNode;
  canEditIcon?: boolean;
}) {
  const { pushToast } = useFeedbackStore();
  const fallback: HomeIdentityValue = { cover: "alpine", positionX: 50, positionY: 50, icon: defaultIcon };
  const [identity, setIdentity] = useState<HomeIdentityValue>(fallback);
  const [draft, setDraft] = useState<HomeIdentityValue>(fallback);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; positionX: number; positionY: number } | null>(null);
  useHomeModal(editing, panelRef, () => { if (!saving) setEditing(false); });

  useEffect(() => {
    let active = true;
    setIdentity({ cover: "alpine", positionX: 50, positionY: 50, icon: defaultIcon });
    void readHomeIdentity(identityKey).then((value) => {
      if (active && value) setIdentity(value);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [identityKey, defaultIcon]);

  const image = (value: HomeIdentityValue) => value.cover === "custom" && value.customDataUrl
    ? value.customDataUrl : value.cover === "forest" ? forestCover : alpineCover;

  async function save() {
    setSaving(true);
    try {
      await writeHomeIdentity(identityKey, draft);
      setIdentity(draft);
      setEditing(false);
      window.dispatchEvent(new CustomEvent("home-identity-changed", { detail: identityKey }));
    } catch (error) {
      pushToast({ tone: "error", title: "保存封面失败", detail: String(error) });
    } finally {
      setSaving(false);
    }
  }

  return <>
    <header className="home-cover" style={{ backgroundImage: `linear-gradient(to bottom, transparent 25%, var(--home-cover-fade) 48%, var(--home-canvas) 100%), url("${image(identity)}")`, backgroundPosition: `center, ${identity.positionX}% ${identity.positionY}%` }}>
      <div className="home-cover__identity">
        <div className="home-cover__icon"><HomeIdentityIcon name={identity.icon} /></div>
        <div className="home-cover__titles"><div className="home-cover__title">{title}</div><div className="home-cover__subtitle">{subtitle}</div></div>
      </div>
      <button type="button" className="home-cover__edit" onClick={() => { setDraft(identity); setEditing(true); }}><Pencil size={15} /> 编辑封面</button>
    </header>
    {editing ? <div className="home-cover-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(false); }}>
      <div ref={panelRef} className="home-cover-dialog" role="dialog" aria-modal="true" aria-label="编辑首页封面">
        <div className="home-cover-dialog__top"><strong>编辑首页封面</strong><button type="button" aria-label="关闭" onClick={() => setEditing(false)}><X size={18} /></button></div>
        <div className="home-cover-dialog__preview" title="拖动图片调整裁切位置" onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, positionX: draft.positionX, positionY: draft.positionY };
        }} onPointerMove={(event) => {
          const start = dragRef.current;
          if (!start) return;
          setDraft((value) => ({ ...value,
            positionX: Math.max(0, Math.min(100, start.positionX - (event.clientX - start.x) / 3)),
            positionY: Math.max(0, Math.min(100, start.positionY - (event.clientY - start.y) / 3)),
          }));
        }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} style={{ backgroundImage: `linear-gradient(to bottom, transparent 25%, var(--home-canvas) 100%), url("${image(draft)}")`, backgroundPosition: `center, ${draft.positionX}% ${draft.positionY}%` }} />
        <div className="home-cover-dialog__body">
          <p>内置封面</p><div className="home-cover-dialog__choices">
            {(["alpine", "forest"] as const).map((cover) => <button key={cover} type="button" aria-pressed={draft.cover === cover} onClick={() => setDraft({ ...draft, cover })}><img src={cover === "alpine" ? alpineCover : forestCover} alt={cover === "alpine" ? "雪山" : "森林"} /><span>{cover === "alpine" ? "雪山" : "森林"}</span></button>)}
            <button type="button" className="home-cover-dialog__upload" disabled={uploading} onClick={() => uploadRef.current?.click()}>{uploading ? "处理图片中…" : "上传图片"}</button>
            <input ref={uploadRef} hidden type="file" accept="image/*" onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setUploading(true);
              void resizeHomeCover(file).then((customDataUrl) => setDraft((current) => ({ ...current, cover: "custom", customDataUrl })))
                .catch((error) => pushToast({ tone: "error", title: "无法读取封面", detail: String(error) }))
                .finally(() => { setUploading(false); if (uploadRef.current) uploadRef.current.value = ""; });
            }} />
          </div>
          <label>水平位置 <input type="range" min="0" max="100" value={draft.positionX} onChange={(event) => setDraft({ ...draft, positionX: Number(event.target.value) })} /></label>
          <label>垂直位置 <input type="range" min="0" max="100" value={draft.positionY} onChange={(event) => setDraft({ ...draft, positionY: Number(event.target.value) })} /></label>
          {canEditIcon ? <><p>项目图标</p><div className="home-cover-dialog__icons">{Object.keys(ICONS).filter((name) => name !== "House").map((name) => <button key={name} type="button" aria-label={name} aria-pressed={draft.icon === name} onClick={() => setDraft({ ...draft, icon: name })}><HomeIdentityIcon name={name} size={20} /></button>)}</div></> : null}
        </div><div className="home-cover-dialog__foot"><button type="button" onClick={() => setEditing(false)}>取消</button><button type="button" className="home-cover-dialog__save" disabled={saving || uploading} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button></div>
      </div>
    </div> : null}
  </>;
}

export function ProjectHomeIcon({ rootPath, size = 18 }: { rootPath: string; size?: number }) {
  const [name, setName] = useState("Compass");
  useEffect(() => {
    let active = true;
    const load = () => { void readHomeIdentity(`project:${rootPath}`).then((value) => { if (active) setName(value?.icon ?? "Compass"); }).catch(() => undefined); };
    load();
    window.addEventListener("home-identity-changed", load);
    return () => { active = false; window.removeEventListener("home-identity-changed", load); };
  }, [rootPath]);
  return <HomeIdentityIcon name={name} size={size} />;
}
