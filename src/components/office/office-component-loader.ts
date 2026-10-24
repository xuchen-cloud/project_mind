/** Cache code only. File identity, authority, models and renderer instances stay with their owners. */
function componentModule<T>(load: () => Promise<T>, name: string): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      if (import.meta.env.OFFICE_PERFORMANCE) performance.mark(`office-component:${name}:requested`);
      pending = load().then(module => {
        if (import.meta.env.OFFICE_PERFORMANCE) performance.mark(`office-component:${name}:ready`);
        return module;
      }).catch(error => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
export const loadOfficeHost = componentModule(() => import('./OfficeFileContent'), 'host');
export const loadDocxEditor = componentModule(() => import('./DocxEditor'), 'docx');
export const loadXlsxEditor = componentModule(() => import('./XlsxEditor'), 'xlsx');
export const loadPptxEditor = componentModule(() => import('./PptxEditor'), 'pptx');

/** Called only for the explicitly opened, visible File; imports no other format. */
export function preloadOfficeComponents(name?: string): void {
  const format = name?.match(/\.(docx|xlsx|pptx)$/iu)?.[1].toLowerCase();
  if (!format) return;
  // Rejections are surfaced by the same promises at the actual host/format mount.
  void loadOfficeHost().catch(() => {});
  void (format === 'docx' ? loadDocxEditor() : format === 'xlsx' ? loadXlsxEditor() : loadPptxEditor()).catch(() => {});
}
