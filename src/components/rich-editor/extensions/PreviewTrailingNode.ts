import { TrailingNode } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import { EDITOR_REWRITE_PROTECTION_PLUGIN_KEY } from "../editorRewriteProtection";

// A transient AI preview may end with a heading/table. Its helper paragraph
// must not escape the protected range and survive accepting or rejecting it.
export const PreviewTrailingNode = TrailingNode.extend({
  addProseMirrorPlugins() {
    return (this.parent?.() ?? []).map((plugin) => {
      const append = plugin.spec.appendTransaction;
      if (!append) return plugin;
      return new Plugin({
        ...plugin.spec,
        appendTransaction(transactions, oldState, state) {
          const ranges = EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(state) ?? {};
          const end = state.doc.content.size;
          const lastStart = end - (state.doc.lastChild?.nodeSize ?? 0);
          if (Object.values(ranges).some((range) => range.from < end && range.to > lastStart)) {
            return null;
          }
          return append.call(this, transactions, oldState, state);
        },
      });
    });
  },
});
