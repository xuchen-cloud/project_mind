import { Extension } from '@tiptap/core'
import { moveSelectedBlocks, uiOp } from './ops'

/**
 * SecondBrain-parity block shortcuts: ⌘D duplicate, ⌘⇧⌫ delete,
 * ⌘⇧↑/↓ move the current top-level block, ⌘K link.
 */
export const BlockKeymap = Extension.create({
  name: 'blockKeymap',

  addKeyboardShortcuts() {
    const editable = (run: () => boolean) => () => this.editor.isEditable && run()
    return {
      'Mod-d': editable(() => uiOp(this.editor, { op: 'duplicateBlocks', target: 'selection' })),
      'Mod-D': editable(() => uiOp(this.editor, { op: 'duplicateBlocks', target: 'selection' })),
      'Mod-Shift-Backspace': editable(() => uiOp(this.editor, { op: 'deleteBlocks', target: 'selection' })),
      'Mod-Shift-ArrowUp': editable(() => moveSelectedBlocks(this.editor, -1)),
      'Mod-Shift-ArrowDown': editable(() => moveSelectedBlocks(this.editor, 1)),
      'Mod-k': () => {
        if(!this.editor.isEditable)return false
        const editor = this.editor
        if (editor.isActive('link')) {
          return uiOp(editor, { op: 'setLink', target: 'selection', href: null })
        }
        const href = window.prompt('URL:')
        if (!href?.trim()) return true
        return uiOp(editor, { op: 'setLink', target: 'selection', href: href.trim() })
      },
    }
  },
})
