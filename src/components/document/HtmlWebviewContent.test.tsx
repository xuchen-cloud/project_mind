import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { htmlPreviewApi, type HtmlPreviewStatus } from "../../services/htmlPreviewApi";
import { HtmlWebviewContent } from "./HtmlWebviewContent";
vi.mock("../../services/htmlPreviewApi", () => ({ htmlPreviewApi: { create: vi.fn(), close: vi.fn(), layout: vi.fn(), status: vi.fn(), action: vi.fn() } }));
const binding = { workspaceId: 'w', generation: 'g' };
const input = { object: { workspaceId: 'w', kind: 'file' as const, id: '7', scope: { kind: 'project' as const, projectId: 2 } }, versionNumber: 2, expectedContentHash: 'hash2' };
const props = { binding, input, historical: false, visible: true };
const rect = (x = 20, y = 100, width = 700, height = 500) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() {} });
let resize: ResizeObserverCallback;
let area = rect();
beforeEach(() => {
  vi.resetAllMocks();
  area = rect();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return this.classList.contains('html-webview__host') ? area : rect(0, 0, 1024, 768); });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback; } observe() {} disconnect() {} });
  vi.mocked(htmlPreviewApi.create).mockResolvedValue({ id: 'session', url: 'http://127.0.0.1:1234/' });
  vi.mocked(htmlPreviewApi.layout).mockResolvedValue();
  vi.mocked(htmlPreviewApi.close).mockResolvedValue();
  vi.mocked(htmlPreviewApi.action).mockResolvedValue();
  vi.mocked(htmlPreviewApi.status).mockResolvedValue({ url: 'http://127.0.0.1:1234/', loading: false, diagnostics: [] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function shown() { await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session', expect.objectContaining({ visible: true }))); }
it('preserves the native session while hidden and restores its DOM bounds without recreating it', async () => {
  const rendered = render(<HtmlWebviewContent {...props} />); await shown();
  expect(htmlPreviewApi.create).toHaveBeenCalledWith(binding, input, false);
  expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session', { x: 20, y: 100, width: 700, height: 500, viewportWidth: 1024, viewportHeight: 768, visible: true, pageWidth: 0 });
  rendered.rerender(<HtmlWebviewContent {...props} visible={false} />);
  await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session', expect.objectContaining({ visible: false })));
  expect(htmlPreviewApi.close).not.toHaveBeenCalled();
  const polls = vi.mocked(htmlPreviewApi.status).mock.calls.length;
  vi.useFakeTimers(); await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(htmlPreviewApi.status).toHaveBeenCalledTimes(polls); vi.useRealTimers();
  rendered.rerender(<HtmlWebviewContent {...props} />); await shown();
  expect(htmlPreviewApi.create).toHaveBeenCalledOnce();
  rendered.unmount(); expect(htmlPreviewApi.close).toHaveBeenCalledWith('session');
});
it.each(['hidden', 'unmounted'] as const)('closes a late native creation after becoming %s without showing it', async mode => {
  let finish!: (value: {id:string;url:string}) => void;
  vi.mocked(htmlPreviewApi.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const rendered = render(<HtmlWebviewContent {...props} />);
  if (mode === 'hidden') rendered.rerender(<HtmlWebviewContent {...props} visible={false} />); else rendered.unmount();
  await act(async () => finish({ id: 'late', url: 'http://127.0.0.1:1234/' }));
  expect(htmlPreviewApi.close).toHaveBeenCalledWith('late');
  expect(htmlPreviewApi.layout).not.toHaveBeenCalled();
  expect(htmlPreviewApi.create).toHaveBeenCalledOnce();
});
it('closes the old version and generation and ignores late statuses from retired sessions', async () => {
  let finish!: (value: HtmlPreviewStatus) => void;
  vi.mocked(htmlPreviewApi.status).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const rendered = render(<HtmlWebviewContent {...props} />); await shown();
  vi.mocked(htmlPreviewApi.create).mockResolvedValueOnce({ id: 'history', url: 'http://127.0.0.1:4321/' });
  rendered.rerender(<HtmlWebviewContent {...props} binding={{...binding, generation:'next'}} input={{...input,versionNumber:1,expectedContentHash:'hash1'}} historical />);
  await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('history', expect.anything()));
  expect(htmlPreviewApi.close).toHaveBeenCalledWith('session');
  expect(htmlPreviewApi.create).toHaveBeenLastCalledWith({...binding,generation:'next'}, {...input,versionNumber:1,expectedContentHash:'hash1'}, true);
  await act(async () => finish({ url: 'old', loading: false, diagnostics: ['stale error'] }));
  expect(screen.queryByText('stale error')).toBeNull();
});
it('hides native content for overlapping menus, dialogs, listboxes, context panels and popovers, then restores it', async () => {
  const rendered = render(<HtmlWebviewContent {...props} />); await shown();
  for (const attributes of [{role:'menu'}, {role:'dialog'}, {role:'listbox'}, {class:'context-menu__panel'}, {popover:'auto'}]) {
    const overlay = document.createElement('div');
    for (const [name, value] of Object.entries(attributes)) overlay.setAttribute(name,value);
    if ('popover' in attributes) overlay.style.display = 'block'; // Model an open popover; closed popovers have display:none.
    await act(async () => document.body.append(overlay));
    await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({visible:false})));
    await act(async () => overlay.remove()); await shown();
  }
  expect(htmlPreviewApi.create).toHaveBeenCalledOnce(); rendered.unmount();
});
it('ignores hidden and nonoverlapping overlays and updates clipping, ancestor visibility, drag and container position', async () => {
  const rendered = render(<div className="project-content"><HtmlWebviewContent {...props} /></div>); await shown();
  const ancestor = rendered.container.firstElementChild!;
  const overlay = document.createElement('div'); overlay.setAttribute('role','menu'); overlay.hidden = true;
  await act(async () => document.body.append(overlay)); await shown();
  overlay.getBoundingClientRect = () => rect(900, 100, 50, 50);
  await act(async () => { overlay.hidden = false; }); await shown();
  await act(async () => ancestor.setAttribute('data-dragging','tab'));
  await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({visible:false})));
  await act(async () => ancestor.removeAttribute('data-dragging')); await shown();
  await act(async () => ancestor.setAttribute('hidden',''));
  await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({visible:false})));
  await act(async () => ancestor.removeAttribute('hidden')); await shown();
  area = rect(30,120,600,450);
  await act(async () => resize([], {} as ResizeObserver));
  await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({x:30,y:120,width:600,height:450,visible:true})));
  area = rect(30,150,600,450); fireEvent.scroll(window);
  await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({y:150})));
  overlay.remove();
});
it('supports navigation and all viewport presets, rendering diagnostics as text without mutation feedback', async () => {
  const diagnostic = '<img src=x onerror="attack()">';
  vi.mocked(htmlPreviewApi.status).mockResolvedValue({url:'https://example.com',loading:true,diagnostics:[diagnostic]});
  const rendered = render(<HtmlWebviewContent {...props} />); await shown();
  await screen.findByText(diagnostic); expect(rendered.container.querySelector('img')).toBeNull();
  const layouts = vi.mocked(htmlPreviewApi.layout).mock.calls.length;
  await act(async () => {}); expect(htmlPreviewApi.layout).toHaveBeenCalledTimes(layouts);
  fireEvent.click(screen.getByRole('button',{name:'后退'})); fireEvent.click(screen.getByRole('button',{name:'前进'}));
  expect(htmlPreviewApi.action).toHaveBeenCalledWith('session','back'); expect(htmlPreviewApi.action).toHaveBeenCalledWith('session','forward');
  for (const {value, visibleWidth} of [{value:'375',visibleWidth:375},{value:'768',visibleWidth:700},{value:'1440',visibleWidth:700},{value:'0',visibleWidth:700}]) {
    area = rect(20,100,visibleWidth,500);
    fireEvent.change(screen.getByRole('combobox',{name:'网页视口宽度'}),{target:{value}});
    expect(screen.getByLabelText('原生网页显示区域')).toHaveStyle({width:value === '0' ? '100%' : `min(100%, ${value}px)`});
    await waitFor(() => expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({pageWidth:Number(value),width:visibleWidth})));
  }
});
it('ignores an in-flight status after hiding and reports a real create failure without any iframe fallback', async () => {
  let finish!: (value: HtmlPreviewStatus) => void;
  vi.mocked(htmlPreviewApi.status).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  const rendered = render(<HtmlWebviewContent {...props} />); await shown();
  rendered.rerender(<HtmlWebviewContent {...props} visible={false} />);
  await act(async () => finish({url:'old',loading:false,diagnostics:['late hidden status']}));
  expect(screen.queryByText('late hidden status')).toBeNull(); rendered.unmount();
  vi.mocked(htmlPreviewApi.create).mockRejectedValueOnce({message:'WebView unavailable'});
  const failed = render(<HtmlWebviewContent {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('WebView unavailable');
  expect(failed.container.querySelector('iframe')).toBeNull();
});
it('retires an in-flight creation invalidated by hiding even if the tab becomes visible before it resolves', async () => {
  let finish!: (value: {id:string;url:string}) => void;
  vi.mocked(htmlPreviewApi.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const rendered = render(<HtmlWebviewContent {...props} />);
  rendered.rerender(<HtmlWebviewContent {...props} visible={false} />);
  rendered.rerender(<HtmlWebviewContent {...props} />);
  await act(async () => finish({id:'retired',url:'http://127.0.0.1:1234/'}));
  await waitFor(() => expect(htmlPreviewApi.close).toHaveBeenCalledWith('retired'));
  expect(htmlPreviewApi.layout).not.toHaveBeenCalledWith('retired',expect.anything());
  await shown(); expect(htmlPreviewApi.create).toHaveBeenCalledTimes(2);
});
it('stops frame work while hidden or occluded and resumes from DOM events', async () => {
  vi.useFakeTimers();
  const styles = vi.spyOn(window,'getComputedStyle');
  const rendered = render(<HtmlWebviewContent {...props} />);
  await act(async () => {});
  rendered.rerender(<HtmlWebviewContent {...props} visible={false} />);
  await act(async () => {});
  const hiddenReads = styles.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(styles).toHaveBeenCalledTimes(hiddenReads);
  rendered.rerender(<HtmlWebviewContent {...props} />);
  await act(async () => {});
  expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({visible:true}));
  const overlay = document.createElement('div'); overlay.setAttribute('role','dialog');
  await act(async () => document.body.append(overlay));
  expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({visible:false}));
  const occludedReads = styles.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(styles).toHaveBeenCalledTimes(occludedReads);
  await act(async () => overlay.remove());
  expect(htmlPreviewApi.layout).toHaveBeenLastCalledWith('session',expect.objectContaining({visible:true}));
});
it.each(['version', 'generation', 'project'] as const)('closes a late creation for the previous %s without showing the old page', async change => {
  let finish!: (value: {id:string;url:string}) => void;
  vi.mocked(htmlPreviewApi.create).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  const rendered = render(<HtmlWebviewContent {...props} />);
  const next = {
    ...props,
    binding: change === 'generation' ? {...binding,generation:'next'} : binding,
    input: change === 'version' ? {...input,versionNumber:1,expectedContentHash:'hash1'} : change === 'project' ? {...input,object:{...input.object,scope:{kind:'project' as const,projectId:3}}} : input,
  };
  rendered.rerender(<HtmlWebviewContent {...next} />); await shown();
  await act(async () => finish({id:'old-identity',url:'http://127.0.0.1:1234/'}));
  expect(htmlPreviewApi.close).toHaveBeenCalledWith('old-identity');
  expect(htmlPreviewApi.layout).not.toHaveBeenCalledWith('old-identity',expect.anything());
  expect(htmlPreviewApi.create).toHaveBeenLastCalledWith(next.binding,next.input,false);
});
