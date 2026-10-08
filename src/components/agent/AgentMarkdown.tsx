import { createElement, useMemo, useState, type ReactNode } from "react";
import { defaultMarkdownParser } from "@tiptap/pm/markdown";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { desktopApi } from "../../services/desktopApi";
import "./agent-markdown.css";

// Use the existing Markdown parser with its standard table rules, without mutating
// the editor's shared CommonMark tokenizer. Raw HTML stays escaped Markdown text.
const MarkdownTokenizer = defaultMarkdownParser.tokenizer.constructor as new (
  preset: "default", options: { html: boolean; linkify: boolean; typographer: boolean },
) => typeof defaultMarkdownParser.tokenizer;
const markdown = new MarkdownTokenizer("default", { html: false, linkify: false, typographer: false });
const readingTags = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "strong", "em", "s", "hr", "br", "table", "thead", "tbody", "tr", "th", "td"]);
type ParsedNode = DefaultTreeAdapterMap["childNode"];

function externalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

/** Read-only Markdown: React owns every node; no HTML mount or image resource exists. */
export function AgentMarkdown({ text }: { text: string }) {
  const [linkError, setLinkError] = useState(false);
  const parsed = useMemo(() => parseFragment(markdown.render(text)), [text]);
  const link = (url: string, children: ReactNode, key: string) => <a key={key} href={url} rel="noreferrer" onClick={event => {
    event.preventDefault();
    setLinkError(false);
    void desktopApi.openExternalUrl(url).catch(() => setLinkError(true));
  }}>{children}</a>;
  const renderNode = (node: ParsedNode, key: string): ReactNode => {
    if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
    if (!("tagName" in node)) return null;
    const attr = (name: string) => node.attrs.find(attribute => attribute.name === name)?.value;
    const children = node.childNodes.filter(child => !(["table", "thead", "tbody", "tr"].includes(node.tagName) && child.nodeName === "#text" && !(child as DefaultTreeAdapterMap["textNode"]).value.trim()))
      .map((child, index) => renderNode(child, `${key}.${index}`));
    if (node.tagName === "img") {
      const url = externalUrl(attr("src"));
      const label = `[图片${attr("alt") ? `：${attr("alt")}` : ""}，${url ? "点击打开" : "未加载"}]`;
      return <span key={key} className="agent-markdown__image">{url ? link(url, label, `${key}.link`) : label}</span>;
    }
    if (node.tagName === "a") {
      const url = externalUrl(attr("href"));
      if (!url) return <span key={key}>{children}</span>;
      return link(url, children, key);
    }
    if (!readingTags.has(node.tagName)) return <span key={key}>{children}</span>;
    if (node.tagName === "br" || node.tagName === "hr") return createElement(node.tagName, { key });
    const start = node.tagName === "ol" && /^\d+$/u.test(attr("start") ?? "") ? Number(attr("start")) : undefined;
    const element = createElement(node.tagName, { key, ...(start !== undefined ? { start } : {}) }, children);
    return node.tagName === "table" ? <div key={key} className="agent-markdown__table">{element}</div> : element;
  };
  return <div className="agent-markdown">
    {parsed.childNodes.map((node, index) => renderNode(node, String(index)))}
    {linkError ? <p role="alert" className="agent-markdown__error">链接无法打开，请稍后重试。</p> : null}
  </div>;
}
