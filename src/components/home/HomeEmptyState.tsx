import "./home-empty-state.css";

type EmptyKind = "records" | "todos" | "files" | "search";

// A small, monochrome illustration family. All fills inherit the app theme.
function EmptyArtwork({ kind }: { kind: EmptyKind }) {
  if (kind === "records") {
    return (
      <svg className="home-empty__art home-empty__art--bear" viewBox="0 0 180 133" fill="none" aria-hidden="true">
        <g stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
          {/* The scarf tail sits behind the shoulder, with an open lower silhouette. */}
          <path className="home-empty__scarf" d="M44 54C32 63 23 78 14 89L28 97C32 83 38 69 45 61Z" />
          <path d="m14 89-4 5m7-3-4 6m7-4-4 6m7-4-3 6m6-4-3 5m5-3-2 4" />
          <path className="home-empty__paper" d="M44 61C34 78 28 97 24 116L68 118 106 110 118 78 108 64Z" stroke="none" />
          <path d="M44 61C34 78 28 97 24 116M116 82l-8 23" />
          {/* Low, slightly bowed head and asymmetric ears follow the reference. */}
          <path className="home-empty__paper" d="M68 23C67 17 70 12 75 11 80 9 84 11 85 13 98 11 110 16 119 23 123 20 129 21 131 26 133 31 130 36 126 37 128 50 125 62 118 69 109 78 97 77 84 73 70 69 57 59 53 47 54 39 60 29 68 23Z" />
          <path d="M68 23c0 1 1 3 2 4m15-14c1 2 2 6 2 9m-12 1c-2-6 4-7 5-2m46 16-1-2" />
          <ellipse cx="91" cy="53.4" rx="2.35" ry="2.85" transform="rotate(15 91 53.4)" fill="var(--color-text-secondary)" stroke="none" />
          <ellipse cx="115.7" cy="57.3" rx="1.9" ry="2.7" transform="rotate(15 115.7 57.3)" fill="var(--color-text-secondary)" stroke="none" />
          <ellipse cx="105.4" cy="67" rx="5.1" ry="3.25" transform="rotate(5 105.4 67)" fill="var(--color-text-secondary)" stroke="none" />
          <path className="home-empty__scarf" d="M53 43C49 43 45 50 43 54 41 59 44 64 48 68 60 80 83 89 101 86 108 85 113 82 116 77L117 70C108 80 96 76 84 73 70 69 56 59 53 48Z" />
          {/* Keyboard under the resting paw; the screen occludes its right edge. */}
          <path className="home-empty__laptop" d="m70 117 38-11 30 7 20 6-50 6Z" />
          <path d="m78 117 31 5m-22-8 24 5m-14-8 18 4m-5-4-14 7m19-6-13 7m-26-3 9-3m-2 7 10-3" opacity=".6" />
          <path className="home-empty__paper" d="M66 90c4 5 11 5 18 6 8 1 13 8 10 15-3 7-14 8-23 7-12 1-21-2-25-8" />
          <path className="home-empty__laptop" d="m119 76 47-4c5-1 7 1 6 5l-11 38c-1 4-3 6-6 6l-51 5c-2 0-3-2-2-5l12-40c1-3 2-4 5-5Z" />
          <path d="m103 122 56-6" opacity=".45" />
          <ellipse className="home-empty__paper" cx="140.5" cy="97.2" rx="4.4" ry="5.3" transform="rotate(23 140.5 97.2)" />
        </g>
      </svg>
    );
  }
  return (
    <svg className="home-empty__art" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "todos" ? <><circle cx="20" cy="20" r="15" /><path d="m12.5 20 5 5 10-11" /></> :
        kind === "files" ? <><path d="M12 5.5h10l8 8v20a1 1 0 0 1-1 1H12a2 2 0 0 1-2-2v-25a2 2 0 0 1 2-2Z" /><path d="M22 5.5v8h8" /></> :
          <><circle cx="17" cy="17" r="10.5" /><path d="m25 25 9 9" /></>}
    </svg>
  );
}

export function HomeEmptyState({ kind, title, description, actionLabel, onAction, disabled = false }: {
  kind: EmptyKind;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={`home-empty home-empty--${kind}`}>
      <EmptyArtwork kind={kind} />
      <p className="home-empty__title">{title}</p>
      {description ? <p className="home-empty__description">{description}</p> : null}
      {onAction && actionLabel ? <button type="button" className="home-empty__action" disabled={disabled} onClick={onAction}>
        {actionLabel}
        {kind === "records" ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" /></svg> : null}
      </button> : null}
    </div>
  );
}
