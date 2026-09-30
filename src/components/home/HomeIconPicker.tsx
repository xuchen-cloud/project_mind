import { useState } from "react";
import { HOME_ICONS, HOME_ICON_GROUPS } from "./homeIcons";
import { HomeSidebarList } from "./HomeSidebarList";
import { SearchField } from "../../ui/components";

export function HomeIconPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLocaleLowerCase();
  const groups = HOME_ICON_GROUPS.map((group) => ({ ...group, icons: group.icons.filter((icon) =>
    `${group.label} ${icon.label} ${icon.name}`.toLocaleLowerCase().includes(term),
  ) })).filter((group) => group.icons.length);
  return <div className="home-icon-picker">
    <SearchField aria-label="搜索项目图标" placeholder="搜索图标，如学习、设计、旅行" value={query} onChange={(event) => setQuery(event.target.value)} />
    <HomeSidebarList label="项目图标" searchKey={query}>
      {groups.map((group) => <section key={group.label} aria-label={group.label}>
        <h3>{group.label}</h3>
        <div className="home-icon-picker__grid">{group.icons.map(({ name, label }) => {
          const Icon = HOME_ICONS[name];
          return <button key={name} type="button" aria-label={label} title={label} aria-pressed={value === name} onClick={() => onChange(name)}><Icon size={20} strokeWidth={1.8} /></button>;
        })}</div>
      </section>)}
      {!groups.length ? <p className="home-icon-picker__empty">没有匹配的图标，试试其他关键词</p> : null}
    </HomeSidebarList>
  </div>;
}
