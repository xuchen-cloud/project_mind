import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { is, selectAll, selectOne, type Options } from "css-select";
import { DOMParser as SchemaParser, type Schema } from "@tiptap/pm/model";
import { canonicalDocumentJson, initializeRecordDocument, isSafeRecordLink, RecordDocumentError } from "./record-document";
import { serializeRecordDocument } from "./record-document-format";

type HtmlAst = DefaultTreeAdapterMap["node"];

// The schema parser reads this small HTML-AST port. It has no browser document,
// layout engine, script execution or network access. Keeping its parse rules
// authoritative avoids a second set of paragraph/table/custom-node converters.
class HtmlTreeNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI: string | undefined;
  readonly nodeValue: string | null;
  readonly attributes: { name: string; value: string }[];
  readonly childNodes: HtmlTreeNode[] = [];
  parentNode: HtmlTreeNode | null = null;
  previousSibling: HtmlTreeNode | null = null;
  nextSibling: HtmlTreeNode | null = null;

  constructor(source: HtmlAst, depth = 0, budget = { count: 0 }) {
    if (depth > 64 || ++budget.count > 50000) throw new RecordDocumentError("Unsupported HTML depth or node count");
    this.nodeType = "tagName" in source ? 1 : source.nodeName === "#text" ? 3 : source.nodeName === "#comment" ? 8 : 11;
    this.tagName = "tagName" in source ? source.tagName.toUpperCase() : "";
    this.nodeName = this.tagName || source.nodeName;
    this.namespaceURI = "namespaceURI" in source ? source.namespaceURI : undefined;
    this.nodeValue = "value" in source ? source.value : null;
    this.attributes = "attrs" in source ? source.attrs.map(({ name, value }) => ({ name, value })) : [];
    if ("childNodes" in source) for (const child of source.childNodes) this.appendChild(new HtmlTreeNode(child, depth + 1, budget));
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get parentElement(): HtmlTreeNode | null { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue ?? "" : this.childNodes.map((node) => node.textContent).join(""); }
  get ownerDocument() {
    return { createTextNode: (value: string) => new HtmlTreeNode({ nodeName: "#text", value, parentNode: null }) };
  }
  get style() {
    const values = new Map((this.getAttribute("style") ?? "").split(";").filter((part) => part.includes(":"))
      .map((part) => { const colon = part.indexOf(":"); return [part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()] as const; }));
    const style: Record<string, unknown> = { length: values.size, getPropertyValue: (name: string) => values.get(name) ?? "" };
    for (const [name, value] of values) style[name.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase())] = value;
    return style;
  }
  getAttribute(name: string) { return this.attributes.find((attr) => attr.name === name)?.value ?? null; }
  hasAttribute(name: string) { return this.getAttribute(name) !== null; }
  matches(selector: string) { return is(this, selector, selectorOptions); }
  querySelector(selector: string) { return selectOne(selector, this.childNodes, selectorOptions); }
  querySelectorAll(selector: string) { return selectAll(selector, this.childNodes, selectorOptions); }
  closest(selector: string): HtmlTreeNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  appendChild(child: HtmlTreeNode) {
    if (child.parentNode) {
      child.parentNode.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
      if (child.previousSibling) child.previousSibling.nextSibling = child.nextSibling;
      if (child.nextSibling) child.nextSibling.previousSibling = child.previousSibling;
    }
    child.previousSibling = this.childNodes[this.childNodes.length - 1] ?? null;
    child.nextSibling = null;
    if (child.previousSibling) child.previousSibling.nextSibling = child;
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
}

const selectorOptions: Options<HtmlTreeNode, HtmlTreeNode> = { cacheResults: false, adapter: {
  isTag: (node): node is HtmlTreeNode => node.nodeType === 1,
  getAttributeValue: (node, name) => node.getAttribute(name) ?? undefined,
  getChildren: (node) => node.childNodes,
  getName: (node) => node.tagName.toLowerCase(),
  getParent: (node) => node.parentNode,
  getSiblings: (node) => node.parentNode?.childNodes ?? [node],
  getText: (node) => node.textContent,
  hasAttrib: (node, name) => node.hasAttribute(name),
  removeSubsets: (nodes) => nodes.filter((node, index) => nodes.indexOf(node) === index
    && !nodes.some((other) => other !== node && isAncestor(other, node))),
} };

function isAncestor(ancestor: HtmlTreeNode, node: HtmlTreeNode): boolean {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) if (parent === ancestor) return true;
  return false;
}

const neutralTags = new Set(["div", "span", "tbody", "thead", "tfoot", "colgroup", "col", "label", "input"]);
const customTypes = new Set(["attachment", "internal-reference", "contact-mention", "tag-mention", "taskList", "taskItem"]);
const semanticAttributes = new Set(["data-type", "data-block-id", "data-language", "data-language-explicit", "data-path",
  "data-mime-type", "data-document-id", "data-annotation-state", "data-title", "data-href", "data-meta", "data-is-starred",
  "data-ref-kind", "data-ref-id", "data-label", "data-source-ref", "data-contact-id", "data-tag-id", "data-color-key", "data-checked", "data-rich-editor-openable", "data-style-derived"]);
const presentationAttributes = new Set(["class", "style", "contenteditable", "role", "tabindex"]);
const nodeAttributes: Record<string, readonly string[]> = {
  image: ["src", "alt", "title", "width", "height", "data-path", "data-mime-type", "data-document-id", "data-annotation-state"],
  attachment: ["data-type", "data-title", "data-href", "data-path", "data-mime-type", "data-document-id", "data-is-starred", "data-meta", "data-rich-editor-openable"],
  codeBlock: ["data-language", "data-language-explicit"],
  internalReference: ["data-type", "data-ref-kind", "data-ref-id", "data-label", "data-source-ref"],
  contactMention: ["data-type", "data-contact-id", "data-label"],
  tagMention: ["data-type", "data-tag-id", "data-label", "data-color-key"],
  table: ["data-style-derived"], tableCell: ["colspan", "rowspan", "colwidth"], tableHeader: ["colspan", "rowspan", "colwidth"],
  orderedList: ["start", "type"], taskList: ["data-type"], taskItem: ["data-type", "data-checked"],
};

export function parseRecordHtml(html: string, schema: Schema, options: { assetBasePath?: string | null } = {}) {
  const base = options.assetBasePath;
  if (base != null && (typeof base !== "string" || !base || base.includes("\\") || base.includes(":") || base.includes("\0")
    || base.split("/").some((part) => !part || part === "." || part === ".."))) throw new RecordDocumentError("Invalid managed asset base");
  if (new TextEncoder().encode(html).length > 1024 * 1024) throw new RecordDocumentError("Unsupported HTML size: limit is 1 MiB");
  const tree = new HtmlTreeNode(parseFragment(html));
  const parser = SchemaParser.fromSchema(schema);
  const tags = parser.rules.flatMap((rule) => "tag" in rule && rule.tag ? [rule.tag] : []);
  const check = (node: HtmlTreeNode) => {
    if (node.nodeType !== 1) { node.childNodes.forEach(check); return; }
    const tag = node.tagName.toLowerCase();
    const custom = node.getAttribute("data-type");
    if (tag === "a" && !custom && node.hasAttribute("href") && !isSafeRecordLink(node.getAttribute("href"))) {
      throw new RecordDocumentError("Unsupported legacy link URL: preserve the original content for review");
    }
    if ((custom && !customTypes.has(custom)) || (!neutralTags.has(tag) && !tags.some((selector) => node.matches(selector)))) {
      throw new RecordDocumentError(`Unsupported legacy HTML node: ${tag}${custom ? ` (${custom})` : ""}`);
    }
    const matchedNodes = parser.rules.flatMap((rule) => "tag" in rule && rule.tag && rule.node && node.matches(rule.tag) ? [rule.node] : []);
    const allowed = new Set(matchedNodes.flatMap((type) => nodeAttributes[type] ?? []));
    if (matchedNodes.some((type) => schema.nodes[type].spec.attrs?.blockId)) allowed.add("data-block-id");
    if (tag === "a" && !custom) ["href", "title", "target", "rel"].forEach((name) => allowed.add(name));
    if (tag === "input") ["type", "checked"].forEach((name) => allowed.add(name));
    if (tag === "col") allowed.add("width");
    for (const { name } of node.attributes) {
      if ((!semanticAttributes.has(name) && !allowed.has(name) && !presentationAttributes.has(name) && !name.startsWith("aria-"))
        || (semanticAttributes.has(name) && !allowed.has(name))) {
        throw new RecordDocumentError(`Unsupported legacy HTML attribute: ${name}`);
      }
    }
    if (!custom) {
      const supportedStyles = new Set(["font-weight", "font-style", "text-decoration", "text-decoration-line", "white-space"]);
      if (tag === "img" || tag === "table" || tag === "col") ["width", "min-width"].forEach((name) => supportedStyles.add(name));
      for (const part of (node.getAttribute("style") ?? "").split(";").filter((part) => part.trim())) {
        const property = part.slice(0, part.indexOf(":")).trim().toLowerCase();
        if (!supportedStyles.has(property)) throw new RecordDocumentError(`Unsupported legacy HTML style: ${property}`);
      }
    }
    if (custom === "attachment" || custom === "internal-reference" || custom === "contact-mention" || custom === "tag-mention") return;
    node.childNodes.forEach(check);
  };
  check(tree);
  // A structural adapter is sufficient for the schema's read interface. It is
  // intentionally not installed as a global document/HTMLElement polyfill.
  const parsed = parser.parse(tree as unknown as HTMLElement).toJSON();
  const projectPaths = (node: typeof parsed) => {
    if (node.type === "image" || node.type === "attachment") {
      const source = node.attrs?.[node.type === "image" ? "src" : "href"];
      // Older compatibility HTML may carry the relative managed reference
      // only in src/data-href. Infer it only during the one-time migration.
      if (node.attrs?.path == null && typeof source === "string" && source && !source.startsWith("#")
        && !/^[a-z][a-z0-9+.-]*:/i.test(source)) node.attrs = { ...node.attrs, path: source };
      if (base && typeof node.attrs?.path === "string") node.attrs.path = `${base}/${node.attrs.path}`;
    }
    node.content?.forEach(projectPaths);
  };
  projectPaths(parsed);
  const canonical = initializeRecordDocument(parsed, schema);
  const projected = serializeRecordDocument(canonical, schema);
  const restored = initializeRecordDocument(parser.parse(new HtmlTreeNode(parseFragment(projected.html)) as unknown as HTMLElement).toJSON(), schema);
  if (canonicalDocumentJson(canonical) !== canonicalDocumentJson(restored)) {
    throw new RecordDocumentError("Unsupported legacy HTML conversion: semantic round-trip differs");
  }
  return canonical;
}
