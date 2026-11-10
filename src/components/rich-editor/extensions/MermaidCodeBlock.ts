import CodeBlock from "@tiptap/extension-code-block";
import { getRenderedAttributes, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { getDiagramTheme, type DiagramTheme } from "../../../../packages/markdown-editor/src/adapters/diagramTheme";
import { normalizeCodeLanguage } from "../codeHighlight";
import "./MermaidCodeBlock.css";

// Keep the codeBlock schema/serializer, including its language metadata. Only
// the live editor DOM gains a preview; getHTML and clipboard serialization do not.
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({ node: initialNode, editor, view, getPos }) => {
      let node = initialNode;
      let generation = 0;
      let destroyed = false;
      let sourceOpen = false;
      let svg: string | null = null;
      let theme: DiagramTheme = "light";
      let observer: MutationObserver | null = null;
      let renderTimer: ReturnType<typeof setTimeout> | undefined;
      const dom = document.createElement("pre");
      const code = document.createElement("code");
      const ui = document.createElement("span");
      ui.className = "rich-editor__mermaid-ui";
      ui.contentEditable = "false";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "rich-editor__mermaid-toggle";
      const preview = document.createElement("span");
      preview.className = "rich-editor__mermaid-preview";
      preview.setAttribute("role", "button");
      preview.setAttribute("aria-label", "查看 Mermaid 源码");
      preview.tabIndex = 0;
      const status = document.createElement("span");
      status.className = "rich-editor__mermaid-status";
      status.setAttribute("role", "status");
      ui.append(toggle, preview, status);
      // First child must remain code for the inherited language parser.
      dom.append(code, ui);

      const isMermaid = () => normalizeCodeLanguage(node.attrs.language) === "mermaid";
      const selectionInside = () => {
        const pos = getPos();
        const { from, to } = view.state.selection;
        return typeof pos === "number" && from > pos && to < pos + node.nodeSize;
      };
      const show = () => {
        const mermaid = isMermaid();
        ui.hidden = !mermaid;
        code.hidden = mermaid && svg !== null && !sourceOpen;
        preview.hidden = !mermaid || svg === null || sourceOpen;
        toggle.hidden = !mermaid || svg === null;
        toggle.textContent = sourceOpen ? "预览图表" : "查看源码";
        toggle.setAttribute("aria-expanded", String(!code.hidden));
      };
      const syncAttributes = () => {
        const attributes = mergeAttributes(this.options.HTMLAttributes,
          getRenderedAttributes(node, editor.extensionManager.attributes));
        // Preserve ProseMirror's own node decorations on the outer pre.
        for (const name of attributeNames) {
          if (!(name in attributes)) dom.removeAttribute(name);
        }
        attributeNames = Object.keys(attributes);
        for (const [name, value] of Object.entries(attributes)) {
          if (value !== null && value !== undefined) dom.setAttribute(name, String(value));
          else dom.removeAttribute(name);
        }
        dom.classList.toggle("rich-editor__mermaid", isMermaid());
        code.className = node.attrs.language
          ? `${this.options.languageClassPrefix}${node.attrs.language}` : "";
      };
      let attributeNames: string[] = [];
      const openSource = () => {
        sourceOpen = true;
        show();
        const pos = getPos();
        if (view.editable && typeof pos === "number") {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
          view.focus();
        } else {
          // Read-only viewers can inspect/select source without editing it.
          code.tabIndex = -1;
          code.focus({ preventScroll: true });
        }
      };
      const onToggle = () => {
        if (!sourceOpen) return openSource();
        sourceOpen = false;
        show();
        preview.focus({ preventScroll: true });
      };
      const onPreviewKey = (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openSource();
      };
      const onSelection = () => {
        if (editor.isFocused && selectionInside() && isMermaid()) {
          sourceOpen = true;
          show();
        }
      };
      const render = (debounce = false) => {
        clearTimeout(renderTimer);
        renderTimer = undefined;
        const current = ++generation;
        const source = node.textContent;
        if (isMermaid()) theme = getDiagramTheme();
        const renderTheme = theme;
        svg = null;
        preview.replaceChildren();
        status.setAttribute("role", "status");
        status.textContent = isMermaid() ? "正在渲染图表…" : "";
        show();
        if (!isMermaid()) return;
        if (!source.trim()) {
          status.setAttribute("role", "alert");
          status.textContent = "Mermaid 源码为空，请输入图表源码。";
          return;
        }
        const request = () => {
          renderTimer = undefined;
          // Import only when a Mermaid block actually exists.
          void import("../../../../packages/markdown-editor/src/adapters/diagramPreviewSafety")
            .then(({ renderSafeDiagram }) => {
              if (destroyed || current !== generation || renderTheme !== getDiagramTheme()) return;
              return renderSafeDiagram("mermaid", source, renderTheme);
            })
            .then((result) => {
              if (!result || destroyed || current !== generation || renderTheme !== getDiagramTheme()) return;
              if (result.ok) {
                svg = result.svg;
                preview.innerHTML = result.svg; // Sanitized by renderSafeDiagram.
                status.textContent = "";
              } else {
                status.setAttribute("role", "alert");
                status.textContent = `Mermaid 预览失败：${result.error}`;
              }
              show();
            })
            .catch((error: unknown) => {
              if (destroyed || current !== generation || renderTheme !== getDiagramTheme()) return;
              status.setAttribute("role", "alert");
              status.textContent = `Mermaid 预览失败：${error instanceof Error ? error.message : String(error)}`;
              show();
            });
        };
        if (debounce) renderTimer = setTimeout(request, 300);
        else request();
      };
      const syncThemeObserver = () => {
        if (!isMermaid()) {
          observer?.disconnect();
          observer = null;
          return;
        }
        if (observer) return;
        theme = getDiagramTheme();
        observer = new MutationObserver(() => {
          const nextTheme = getDiagramTheme();
          if (theme === nextTheme) return;
          theme = nextTheme;
          render();
        });
        observer.observe(document.documentElement, {
          attributes: true, attributeFilter: ["data-theme", "class", "style"],
        });
      };
      toggle.addEventListener("click", onToggle);
      preview.addEventListener("click", openSource);
      preview.addEventListener("keydown", onPreviewKey);
      editor.on("selectionUpdate", onSelection);
      editor.on("focus", onSelection);
      syncAttributes();
      syncThemeObserver();
      sourceOpen = editor.isFocused && selectionInside();
      render();

      return {
        dom,
        contentDOM: code,
        update(nextNode) {
          if (nextNode.type !== node.type) return false;
          const sourceChanged = nextNode.textContent !== node.textContent;
          const languageChanged = nextNode.attrs.language !== node.attrs.language;
          node = nextNode;
          syncAttributes();
          syncThemeObserver();
          if (sourceChanged || languageChanged) render(sourceChanged && !languageChanged);
          return true;
        },
        stopEvent: (event) => event.target instanceof globalThis.Node && ui.contains(event.target),
        ignoreMutation: (mutation) => {
          if (mutation.type === "selection") return false;
          if (mutation.type === "attributes" && (mutation.target === code || mutation.target === dom)) return true;
          return ui.contains(mutation.target);
        },
        destroy() {
          destroyed = true;
          generation++;
          clearTimeout(renderTimer);
          observer?.disconnect();
          editor.off("selectionUpdate", onSelection);
          editor.off("focus", onSelection);
          toggle.removeEventListener("click", onToggle);
          preview.removeEventListener("click", openSource);
          preview.removeEventListener("keydown", onPreviewKey);
        },
      };
    };
  },
});
