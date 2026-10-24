import { expect, it, vi } from "vitest";
import { desktopApi } from "./desktopApi";
import { htmlPreviewApi } from "./htmlPreviewApi";
vi.mock("./desktopApi", () => ({ desktopApi: { fileCommand: vi.fn() } }));
it('maps the native HTML contract without passing paths or injecting scripts', async () => {
  const binding = { workspaceId: 'w', generation: 'g' };
  const input = { object: { workspaceId: 'w', kind: 'file' as const, id: '7', scope: { kind: 'project' as const, projectId: 2 } }, versionNumber: 3, expectedContentHash: 'hash3' };
  const session = { id: 'session', url: 'http://127.0.0.1:1234/' };
  vi.mocked(desktopApi.fileCommand).mockResolvedValueOnce(session);
  expect(await htmlPreviewApi.create(binding, input, true)).toBe(session);
  expect(desktopApi.fileCommand).toHaveBeenLastCalledWith('html_preview_create', { binding, input, historical: true });
  const bounds = { x: 20, y: 40, width: 375, height: 600, viewportWidth: 1440, viewportHeight: 900, visible: true, pageWidth: 1440 };
  await htmlPreviewApi.layout('session', bounds);
  expect(desktopApi.fileCommand).toHaveBeenLastCalledWith('html_preview_layout', { id: 'session', bounds });
  for (const action of ['back', 'forward', 'reload'] as const) {
    await htmlPreviewApi.action('session', action);
    expect(desktopApi.fileCommand).toHaveBeenLastCalledWith('html_preview_action', { id: 'session', action });
  }
  const status = { url: session.url, loading: false, diagnostics: ['missing dependency'] };
  vi.mocked(desktopApi.fileCommand).mockResolvedValueOnce(status);
  expect(await htmlPreviewApi.status('session')).toBe(status);
  expect(desktopApi.fileCommand).toHaveBeenLastCalledWith('html_preview_status', { id: 'session' });
  await htmlPreviewApi.close('session');
  expect(desktopApi.fileCommand).toHaveBeenLastCalledWith('html_preview_close', { id: 'session' });
});
it('preserves native failures for the caller', async () => {
  const failure = { code: 'SESSION_REVOKED', message: 'Workspace changed' };
  vi.mocked(desktopApi.fileCommand).mockRejectedValueOnce(failure);
  await expect(htmlPreviewApi.status('closed')).rejects.toBe(failure);
});
