import { DOMSerializer, type DOMOutputSpec, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import { serializeRichTextDocumentMarkdown } from "../components/rich-editor/markdown";
import { RecordDocumentError, validateRecordDocument } from "./record-document";

const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");

function relativeAssetPath(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes(":" ) || value.includes("\0")
    || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new RecordDocumentError("Invalid managed asset path: expected a Workspace-relative reference");
  }
  return value;
}

// Render the editor schema's DOMOutputSpec as escaped text, without a DOM or
// browser globals. Native DOM nodes in future custom renderers fail explicitly.
function renderSpec(spec: DOMOutputSpec, content: string): string {
  if (typeof spec === "string") return escapeText(spec);
  if (!Array.isArray(spec) || typeof spec[0] !== "string" || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(spec[0])) {
    throw new RecordDocumentError("Unsupported editor HTML renderer");
  }
  const tag = spec[0];
  const attributes = spec[1] && typeof spec[1] === "object" && !Array.isArray(spec[1]) ? spec[1] : {};
  const children = spec.slice(attributes === spec[1] ? 2 : 1);
  const attrs = Object.entries(attributes).filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => {
      if (!/^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/.test(name) || /^on/i.test(name)) throw new RecordDocumentError("Unsafe editor HTML attribute");
      return ` ${name}="${escapeAttribute(String(value))}"`;
    }).join("");
  if (voidTags.has(tag.toLowerCase())) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${children.map((child) => child === 0 ? content : renderSpec(child as DOMOutputSpec, content)).join("")}</${tag}>`;
}

export function serializeRecordDocument(document: JSONContent, schema: Schema) {
  const canonical = validateRecordDocument(document, schema);
  const serializer = DOMSerializer.fromSchema(schema);
  const node = schema.nodeFromJSON(canonical);
  const renderNode = (current: ProseMirrorNode): string => {
    let html: string;
    if (current.isText) html = escapeText(current.text ?? "");
    else {
      const type = current.type.name;
      const assetPath = type === "image" || type === "attachment" ? relativeAssetPath(current.attrs.path) : null;
      const urlKey = type === "image" ? "src" : "href";
      // The UI renderer resolves managed paths to local display URLs. Supply a
      // portable source to its same schema renderer and restore the path attr.
      const renderedNode = assetPath ? current.type.create({ ...current.attrs, path: null, [urlKey]: `workspace:${assetPath}` }, current.content, current.marks) : current;
      const source = renderedNode.attrs[urlKey];
      if ((type === "image" || type === "attachment") && typeof source === "string"
        && !/^(https?:\/\/|workspace:|#)/i.test(source)) throw new RecordDocumentError("Invalid asset URL: local display URLs cannot be persisted");
      const content = current.content.content.map(renderNode).join("");
      const render = serializer.nodes[type];
      if (!render) throw new RecordDocumentError(`Missing editor HTML renderer: ${type}`);
      const spec = render(renderedNode);
      if (assetPath && Array.isArray(spec)) {
        const attrs = spec[1] && typeof spec[1] === "object" && !Array.isArray(spec[1]) ? spec[1] : {};
        spec.splice(1, attrs === spec[1] ? 1 : 0, { ...attrs, "data-path": assetPath });
      }
      html = renderSpec(spec, content);
    }
    for (const mark of [...current.marks].reverse()) {
      const render = serializer.marks[mark.type.name];
      if (!render) throw new RecordDocumentError(`Missing editor mark renderer: ${mark.type.name}`);
      html = renderSpec(render(mark, current.isInline), html);
    }
    return html;
  };
  return { document: canonical, html: node.content.content.map(renderNode).join(""),
    markdown: serializeRichTextDocumentMarkdown(node), text: node.textBetween(0, node.content.size, "\n\n") };
}
