import React, { useEffect, useId, useRef, useState } from 'react';
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import { installScrollEdges } from './scroll-edges.mjs';

const selectionId = selection => selection ? JSON.stringify([selection.provider, selection.model]) : undefined;

/** Occupies the original composer's model seat; all mutations address its Session. */
export function ModelPicker({ sessionId, locked, useProjection, loadCatalog, selectModel, openModelSettings }) {
  const projection = useProjection('modelSelection');
  const [catalog, setCatalog] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const lifetime = useRef(null);
  const menuClass = `mind-model-menu-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const identity = {};
    lifetime.current = identity;
    setOpen(false); setSaving(false); setError(null); setCatalog(null); setLoading(true);
    void loadCatalog().then(value => {
      if (lifetime.current === identity) setCatalog(value);
    }, reason => {
      if (lifetime.current === identity) setError(reason.message);
    }).finally(() => { if (lifetime.current === identity) setLoading(false); });
    return () => { lifetime.current = null; };
  }, [sessionId, loadCatalog, attempt]);

  useEffect(() => { if (locked) setOpen(false); }, [locked]);

  // Menu portals are outside the conversation host. Reuse the continuous
  // list fades there, including resize and content-change measurement.
  useEffect(() => {
    if (!open) return;
    const viewport = document.getElementsByClassName(menuClass)[0];
    if (viewport) return installScrollEdges(viewport);
  }, [open, menuClass, catalog, error, loading]);

  const current = projection?.next ?? catalog?.default ?? projection?.lastUsed;
  const group = catalog?.groups.find(value => value.id === current?.provider);
  const model = group?.models.find(value => value.id === current?.model);
  const label = model?.name || current?.model || (loading ? '读取模型…' : '选择模型');
  const title = `${group?.name ? `${group.name} · ` : ''}${label}`;
  const unavailable = catalog && current && !model;
  const items = [];
  if (unavailable) items.push({ id: 'unavailable', label: <span role="alert">当前模型已不可用，请选择其他模型</span>, disabled: true });
  if (loading) items.push({ type: 'label', id: 'loading', text: '正在读取可用模型…' });
  for (const provider of catalog?.groups ?? []) {
    if (!provider.models.length) continue;
    items.push({ type: 'label', id: provider.id, text: provider.name });
    for (const option of provider.models) items.push({ id: selectionId({ provider: provider.id, model: option.id }), label: option.name || option.id, disabled: saving });
  }
  if (!loading && !catalog?.groups.some(provider => provider.models.length) && !error)
    items.push({ type: 'label', id: 'empty', text: '请先在模型设置中添加可用模型' });
  for (const failure of catalog?.failures ?? [])
    items.push({ type: 'label', id: `failure:${failure.id}`, text: `${failure.name}：${failure.message}` });
  if (error) {
    items.push({ id: 'error', label: <span role="alert">{error}</span>, disabled: true });
    if (!catalog) items.push({ id: 'retry', label: '重试' });
  }
  const choose = async id => {
    if (id === 'settings') { setOpen(false); openModelSettings(sessionId); return; }
    if (id === 'retry') { setAttempt(value => value + 1); return; }
    const [provider, model] = JSON.parse(id);
    if (id === selectionId(current)) { setOpen(false); return; }
    const identity = lifetime.current;
    setSaving(true); setError(null);
    try {
      const result = await selectModel({ sessionId, provider, model });
      if (!result.ok) throw new Error(result.error.message);
      if (lifetime.current === identity) setOpen(false);
    } catch (reason) {
      if (lifetime.current === identity) { setError(reason.message); setOpen(true); }
    } finally { if (lifetime.current === identity) setSaving(false); }
  };
  return <Menu open={open} items={items} selectedId={selectionId(current)} onSelect={id => { void choose(id); }}
    onClose={() => setOpen(false)} side="top" align="end" portal
    listClassName={`mind-model-menu ${menuClass}`} footer={[{ id: 'settings', label: '管理模型…' }]}
    anchor={<button type="button" className="mind-model-trigger" aria-label={`选择模型：${label}`}
      aria-haspopup="menu" aria-expanded={open} title={title} disabled={locked || saving}
      onClick={() => setOpen(value => !value)}>
      <span className="mind-model-trigger__label">{saving ? '切换中…' : label}</span>
      <span className="mind-model-trigger__chevron" data-open={open} aria-hidden><IconChevronDownOutlineRegular /></span>
    </button>} />;
}
