import { useMemo } from "react";
import { getRenderableRichTextHtml, RichTextViewer } from "../rich-editor";

export function HomeRecordPreview({ html, markdown, active }: { html: string; markdown: string; active: boolean }) {
  const preview = useMemo(() => {
    const document = new DOMParser().parseFromString(getRenderableRichTextHtml({ html, markdown }), "text/html");
    const image = document.querySelector("img");
    const attachment = document.querySelector('[data-type="attachment"]');
    document.querySelectorAll("p,li,div,h1,h2,h3,h4,pre").forEach((node) => node.append(" "));
    return { text: document.body.textContent?.replace(/\s+/gu, " ").trim() || "空记录", image: image?.outerHTML, attachment: attachment?.getAttribute("data-title") };
  }, [html, markdown]);
  return <div className="home-record-preview"><p>{preview.text}</p>{preview.image ? <div className="home-record-preview__image" aria-hidden="true"><RichTextViewer html={preview.image} markdown="" active={active} deferUntilVisible eagerManagedImages /></div> : preview.attachment ? <span className="home-record-preview__attachment">{preview.attachment}</span> : null}</div>;
}
