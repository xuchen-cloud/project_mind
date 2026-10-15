import { useRef, type ReactNode } from "react";
import { HomeCover, HomeIdentityIcon, ProjectHomeIcon } from "./HomeCover";
import { useHomeHeadingMotion } from "./useHomeHeadingMotion";

export function HomeRecordHeader({ identityKey, scopeName, title, projectRoot, showCover = true, onOpenHome, children }: {
  identityKey: string; scopeName: string; title: string; projectRoot?: string; showCover?: boolean; onOpenHome: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const visible = useHomeHeadingMotion(ref, identityKey, title || "未命名记录");
  const scopeLink = (docked = false) => <button type="button" className="home-record-location"
    aria-label={`返回${scopeName}主页`} title={scopeName} tabIndex={docked && !visible ? -1 : undefined} onClick={onOpenHome}>
    {projectRoot ? <ProjectHomeIcon rootPath={projectRoot} size={16} /> : <HomeIdentityIcon name="House" size={16} />}
    <span>{scopeName}</span>
  </button>;
  return <>
    {showCover ? <HomeCover identityKey={identityKey} defaultIcon={projectRoot ? "Compass" : "House"}
      title={<div className="home-record-heading">{scopeLink()}{children}</div>} />
      : <header className="home-record-header"><div className="home-record-heading">{scopeLink()}{children}</div></header>}
    <section ref={ref} className="home-quick-note home-record-dock" data-page-heading="true" data-title-visible={visible || undefined} aria-label="笔记标题">
      <div className="home-quick-note__page-heading" aria-hidden={!visible}>
        {scopeLink(true)}
        <h1>{title || "未命名记录"}</h1>
      </div>
    </section>
  </>;
}
