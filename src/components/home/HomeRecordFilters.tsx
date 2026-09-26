import { Plus, Search, X } from "lucide-react";
export function HomeRecordFilters({ title, query, tag, onQuery, onClearTag, onClearFilters, onCreate }: {
  title: string; query: string; tag?: string; onQuery: (value: string) => void; onClearTag: () => void; onClearFilters: () => void; onCreate: () => void;
}) {
  return <div className="home-record-filters"><h2>{title}</h2>{tag ? <button className="home-record-filters__tag" type="button" onClick={onClearTag}># {tag}<X size={13} /></button> : null}<label><Search size={16} /><input aria-label="搜索记录" placeholder="搜索记录" value={query} onChange={(event) => onQuery(event.target.value)} /></label>{query || tag ? <button type="button" aria-label="清除筛选" onClick={onClearFilters}><X size={16} /></button> : null}<button type="button" aria-label="新增记录" onClick={onCreate}><Plus size={20} /></button></div>;
}
