import { useHomeModal } from "./useHomeModal";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Compass, Pencil, X } from "lucide-react";
import { HOME_ICONS as ICONS } from "./homeIcons";
import { HomeIconPicker } from "./HomeIconPicker";
import { useFeedbackStore } from "../../state/feedback-store";
import alpineCover from "../../assets/home/snow-mountain-cover.jpg";
import forestCover from "../../assets/home/forest-cover.jpg";
import { readHomeIdentity, resizeHomeCover, writeHomeIdentity, type HomeIdentityValue } from "./homeIdentity";

export function HomeIdentityIcon({ name, size = 34 }: { name: string; size?: number }) {
  const Icon = ICONS[name as keyof typeof ICONS] ?? Compass;
  return <Icon size={size} strokeWidth={1.8} />;
}

export function HomeCover({
  identityKey,
  defaultIcon,
  title,
  canEditIcon = false,
}: {
  identityKey: string;
  defaultIcon: keyof typeof ICONS;
  title: ReactNode;
  canEditIcon?: boolean;
}) {
  const { pushToast } = useFeedbackStore();
  const fallback: HomeIdentityValue = { cover: "alpine", positionX: 50, positionY: 50, icon: defaultIcon };
  const [identity, setIdentity] = useState<HomeIdentityValue>(fallback);
  const [draft, setDraft] = useState<HomeIdentityValue>(fallback);
  const [editing, setEditing] = useState(false);
  const [iconOnly, setIconOnly] = useState(false);
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
      pushToast({ tone: "error", title: iconOnly ? "保存项目图标失败" : "保存封面失败", detail: String(error) });
    } finally {
      setSaving(false);
    }
  }

  return <>
    <header className="home-cover" style={{ "--home-cover-image": `url("${image(identity)}")`, "--home-cover-position": `${identity.positionX}% ${identity.positionY}%` } as CSSProperties}>
      <div className="home-cover__scenery" aria-hidden="true" />
      <div className="home-cover__blur" aria-hidden="true" />
      <div className="home-cover__identity">
        {canEditIcon ? <button type="button" className="home-cover__icon home-cover__icon-edit" aria-label="修改项目图标" title="修改项目图标"
          onClick={() => { setDraft(identity); setIconOnly(true); setEditing(true); }}><HomeIdentityIcon name={identity.icon} size={26} /></button>
          : <div className="home-cover__icon"><HomeIdentityIcon name={identity.icon} size={26} /></div>}
        <div className="home-cover__titles"><div className="home-cover__title">{title}</div></div>
      </div>
      <button type="button" className="home-cover__edit" aria-label="编辑封面" title="编辑封面" onClick={() => { setDraft(identity); setIconOnly(false); setEditing(true); }}><Pencil size={14} strokeWidth={1.6} aria-hidden="true" /></button>
    </header>
    {editing ? <div className="home-cover-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(false); }}>
      <div ref={panelRef} className="home-cover-dialog" role="dialog" aria-modal="true" aria-label={iconOnly ? "修改项目图标" : "编辑首页封面"}>
        <div className="home-cover-dialog__top"><strong>{iconOnly ? "修改项目图标" : "编辑首页封面"}</strong><button type="button" aria-label="关闭" onClick={() => setEditing(false)}><X size={18} /></button></div>
        {!iconOnly ? <div className="home-cover-dialog__preview" title="拖动图片调整裁切位置" onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, positionX: draft.positionX, positionY: draft.positionY };
        }} onPointerMove={(event) => {
          const start = dragRef.current;
          if (!start) return;
          setDraft((value) => ({ ...value,
            positionX: Math.max(0, Math.min(100, start.positionX - (event.clientX - start.x) / 3)),
            positionY: Math.max(0, Math.min(100, start.positionY - (event.clientY - start.y) / 3)),
          }));
        }} onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} style={{ backgroundImage: `linear-gradient(to bottom, transparent 25%, var(--home-canvas) 100%), url("${image(draft)}")`, backgroundPosition: `center, ${draft.positionX}% ${draft.positionY}%` }} /> : null}
        <div className="home-cover-dialog__body">
          {!iconOnly ? <><p>内置封面</p><div className="home-cover-dialog__choices">
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
          <label>垂直位置 <input type="range" min="0" max="100" value={draft.positionY} onChange={(event) => setDraft({ ...draft, positionY: Number(event.target.value) })} /></label></> : null}
          {canEditIcon ? <HomeIconPicker value={draft.icon} onChange={(icon) => setDraft({ ...draft, icon })} /> : null}
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
