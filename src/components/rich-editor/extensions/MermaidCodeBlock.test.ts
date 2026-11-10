import { Editor, Extension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramResult } from "../../../../packages/markdown-editor/src/genoffice/editor/diagrams";
import { MermaidCodeBlock } from "./MermaidCodeBlock";
import { filterCodeLanguageOptions } from "../codeHighlight";

const { renderSafeDiagram } = vi.hoisted(() => ({ renderSafeDiagram: vi.fn() }));
vi.mock("../../../../packages/markdown-editor/src/adapters/diagramPreviewSafety", () => ({ renderSafeDiagram }));

// Exercise the same contentDOM widget and inline decoration shape as Record.
const languageDecorations = Extension.create({
  name: "testCodeDecorations",
  addGlobalAttributes() {
    return [{ types: ["codeBlock"], attributes: { languageExplicit: {
      default: true, renderHTML: (attrs) => ({ "data-language-explicit": String(attrs.languageExplicit) }),
    } } }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({ props: { decorations(state) {
      const decorations: Decoration[] = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name !== "codeBlock") return;
        decorations.push(Decoration.widget(pos + 1, () => {
          const button = document.createElement("button");
          button.className = "rich-editor__inline-code-language-button";
          button.textContent = node.attrs.language;
          return button;
        }, { key: `language-${node.attrs.language}` }));
        if (node.textContent.length) decorations.push(Decoration.inline(pos + 1, pos + 2, { class: "test-highlight" }));
      });
      return DecorationSet.create(state.doc, decorations);
    } } })];
  },
});

let editors: Editor[] = [];
let pending: Array<(result: DiagramResult) => void> = [];
function create(language = "mermaid", editable = true) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element, editable,
    extensions: [StarterKit.configure({ codeBlock: false }),
      MermaidCodeBlock.configure({ HTMLAttributes: { class: "configured-code" } }), languageDecorations],
    content: { type: "doc", content: [{ type: "codeBlock", attrs: { language },
      content: [{ type: "text", text: "graph TD; A-->B" }] }] },
  });
  editors.push(editor);
  return editor;
}
function pre(editor: Editor) { return editor.view.nodeDOM(0) as HTMLPreElement; }
function preview(editor: Editor) { return pre(editor).querySelector<HTMLElement>(".rich-editor__mermaid-preview")!; }
function code(editor: Editor) { return pre(editor).querySelector("code")!; }
async function requests(count: number) { await vi.waitFor(() => expect(pending).toHaveLength(count)); }
async function succeed(index: number, label = "diagram") {
  pending[index]({ ok: true, svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${label}</text></svg>` });
  await Promise.resolve();
}

beforeEach(() => {
  document.documentElement.dataset.theme = "light";
  pending = [];
  renderSafeDiagram.mockReset().mockImplementation(() => new Promise<DiagramResult>((resolve) => pending.push(resolve)));
});
afterEach(() => {
  editors.forEach((editor) => { const parent = editor.view.dom.parentElement; editor.destroy(); parent?.remove(); });
  editors = [];
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("color-scheme");
  vi.useRealTimers();
});

describe("MermaidCodeBlock", () => {
  it("keeps ordinary code DOM, configured attributes, language widget and highlighting", () => {
    const editor = create("typescript");
    expect(pre(editor).tagName).toBe("PRE");
    expect(pre(editor).firstElementChild).toBe(code(editor));
    expect(pre(editor)).toHaveClass("configured-code");
    expect(pre(editor)).toHaveAttribute("data-language-explicit", "true");
    expect(code(editor)).toHaveClass("language-typescript");
    expect(code(editor).hidden).toBe(false);
    expect(code(editor).querySelector(".test-highlight")).not.toBeNull();
    expect(code(editor).querySelector("button")?.textContent).toBe("typescript");
    expect(renderSafeDiagram).not.toHaveBeenCalled();
    expect(filterCodeLanguageOptions("mermaid").map((option) => option.id)).toEqual(["mermaid"]);
  });

  it("shows safe SVG, opens editable source on click, and serializes only source", async () => {
    const editor = create();
    await requests(1);
    expect(renderSafeDiagram).toHaveBeenCalledWith("mermaid", "graph TD; A-->B", "light");
    await succeed(0);
    await vi.waitFor(() => expect(preview(editor).querySelector("svg")).not.toBeNull());
    expect(code(editor).hidden).toBe(true);
    const html = editor.getHTML();
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain("graph TD; A--&gt;B");
    expect(html).not.toMatch(/svg|mermaid-preview|查看源码|正在渲染/);
    preview(editor).click();
    expect(code(editor).hidden).toBe(false);
    expect(editor.state.selection.from).toBe(1);
    editor.commands.insertContent("X");
    expect(editor.getText()).toContain("Xgraph");
    expect(preview(editor).querySelector("svg")).toBeNull();
  });

  it.each(["Enter", " "])("opens read-only source with %s without changing document or selection", async (key) => {
    const editor = create("mermaid", false);
    await requests(1);
    await succeed(0);
    await vi.waitFor(() => expect(code(editor).hidden).toBe(true));
    const json = editor.getJSON();
    const selection = editor.state.selection;
    preview(editor).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(code(editor).hidden).toBe(false);
    expect(editor.view.editable).toBe(false);
    expect(editor.view.dom).toHaveAttribute("contenteditable", "false");
    expect(editor.getJSON()).toEqual(json);
    expect(editor.state.selection).toBe(selection);
  });

  it("discards old source results and renders the current source", async () => {
    const editor = create();
    await requests(1);
    editor.commands.insertContentAt({ from: 1, to: 15 }, "graph LR; C-->D");
    await requests(2);
    await succeed(0, "stale");
    expect(preview(editor).querySelector("svg")).toBeNull();
    await succeed(1, "current");
    await vi.waitFor(() => expect(preview(editor).textContent).toBe("current"));
  });

  it("debounces source typing and clears obsolete SVG/error immediately", async () => {
    const editor = create();
    await requests(1);
    await succeed(0);
    await vi.waitFor(() => expect(preview(editor).querySelector("svg")).not.toBeNull());
    vi.useFakeTimers();
    editor.commands.insertContentAt(1, "A");
    expect(preview(editor).querySelector("svg")).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    editor.commands.insertContentAt(1, "B");
    await vi.advanceTimersByTimeAsync(299);
    expect(renderSafeDiagram).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await requests(2);
    expect(renderSafeDiagram).toHaveBeenCalledTimes(2);
    expect(renderSafeDiagram).toHaveBeenLastCalledWith("mermaid", "BAgraph TD; A-->B", "light");
    pending[1]({ ok: false, error: "invalid source" });
    await vi.waitFor(() => expect(pre(editor).querySelector('[role="alert"]')?.textContent).toContain("invalid source"));
    editor.commands.insertContentAt(1, "C");
    expect(pre(editor).querySelector('[role="alert"]')).toBeNull();
    expect(pre(editor).querySelector('[role="status"]')?.textContent).toContain("正在渲染");
  });

  it("cancels a pending source debounce on destroy", async () => {
    const editor = create();
    await requests(1);
    vi.useFakeTimers();
    editor.commands.insertContentAt(1, "A");
    const parent = editor.view.dom.parentElement;
    editor.destroy();
    editors = [];
    parent?.remove();
    await vi.advanceTimersByTimeAsync(350);
    expect(renderSafeDiagram).toHaveBeenCalledTimes(1);
  });

  it("alerts on empty source without invoking the renderer", () => {
    const editor = create("text");
    editor.commands.setContent({ type: "doc", content: [{ type: "codeBlock", attrs: { language: "mermaid" } }] });
    expect(pre(editor).querySelector('[role="alert"]')?.textContent).toContain("源码为空");
    expect(code(editor).hidden).toBe(false);
    expect(renderSafeDiagram).not.toHaveBeenCalled();
  });

  it("immediately clears visible SVG on source change and shows readable errors", async () => {
    const editor = create();
    await requests(1);
    await succeed(0);
    await vi.waitFor(() => expect(code(editor).hidden).toBe(true));
    editor.commands.insertContentAt(1, "invalid ");
    expect(preview(editor).querySelector("svg")).toBeNull();
    expect(code(editor).hidden).toBe(false);
    await requests(2);
    pending[1]({ ok: false, error: "语法错误 <script>" });
    await vi.waitFor(() => expect(pre(editor).querySelector('[role="alert"]')?.textContent).toContain("语法错误 <script>"));
    expect(pre(editor).querySelector("script")).toBeNull();
    expect(code(editor).hidden).toBe(false);
  });

  it("invalidates pending and visible previews when the language changes", async () => {
    const editor = create();
    await requests(1);
    editor.commands.updateAttributes("codeBlock", { language: "javascript" });
    await succeed(0, "stale");
    expect(preview(editor).querySelector("svg")).toBeNull();
    expect(code(editor)).toHaveClass("language-javascript");
    expect(code(editor).hidden).toBe(false);
    expect(code(editor).querySelector("button")?.textContent).toBe("javascript");
    editor.commands.updateAttributes("codeBlock", { language: "mermaid" });
    await requests(2);
    await succeed(1);
    await vi.waitFor(() => expect(preview(editor).querySelector("svg")).not.toBeNull());
    editor.commands.updateAttributes("codeBlock", { language: "text" });
    expect(preview(editor).querySelector("svg")).toBeNull();
  });

  it("observes theme changes, clears old SVG and discards stale theme results", async () => {
    const editor = create();
    await requests(1);
    await succeed(0);
    await vi.waitFor(() => expect(preview(editor).querySelector("svg")).not.toBeNull());
    document.documentElement.dataset.theme = "dark";
    await requests(2);
    expect(preview(editor).querySelector("svg")).toBeNull();
    expect(renderSafeDiagram).toHaveBeenLastCalledWith("mermaid", "graph TD; A-->B", "dark");
    document.documentElement.dataset.theme = "light";
    await requests(3);
    await succeed(1, "dark-stale");
    expect(preview(editor).querySelector("svg")).toBeNull();
    await succeed(2, "light-current");
    await vi.waitFor(() => expect(preview(editor).textContent).toBe("light-current"));
  });

  it("reports rejected rendering promises and keeps the source available", async () => {
    renderSafeDiagram.mockRejectedValueOnce(new Error("renderer unavailable"));
    const editor = create();
    await vi.waitFor(() => expect(pre(editor).querySelector('[role="alert"]')?.textContent).toContain("renderer unavailable"));
    expect(code(editor).hidden).toBe(false);
  });

  it.each(["class", "style"])("observes root %s theme changes", async (attribute) => {
    const editor = create();
    await requests(1);
    delete document.documentElement.dataset.theme;
    if (attribute === "class") document.documentElement.classList.add("dark");
    else document.documentElement.style.colorScheme = "dark";
    await requests(2);
    expect(renderSafeDiagram).toHaveBeenLastCalledWith("mermaid", "graph TD; A-->B", "dark");
  });

  it("disconnects the theme observer and ignores completion after destroy", async () => {
    const editor = create();
    await requests(1);
    const element = pre(editor);
    editor.destroy();
    editors = [];
    document.documentElement.dataset.theme = "dark";
    await succeed(0);
    await Promise.resolve();
    expect(element.querySelector("svg")).toBeNull();
    expect(renderSafeDiagram).toHaveBeenCalledTimes(1);
    element.parentElement?.remove();
  });
});
