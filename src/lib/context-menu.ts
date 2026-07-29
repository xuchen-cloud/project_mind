export function shouldIgnoreContextMenuTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(target.closest("textarea, input, [contenteditable='true'], [role='textbox']"));
}
