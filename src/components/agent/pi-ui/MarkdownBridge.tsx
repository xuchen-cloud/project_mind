import { createRoot, type Root } from "react-dom/client";
import { LitElement, html, type PropertyValues } from "lit";
import { AgentMarkdown } from "../AgentMarkdown";
/** Self-contained safe Markdown leaf; source cards use host React portals instead. */
export class MarkdownBridge extends LitElement {
  static properties = { content: { type: String } };
  declare content: string;
  private reactRoot: Root | undefined;
  constructor() { super(); this.content = ""; }
  protected createRenderRoot() { return this; }
  render() { return html`<div class="pi-markdown-root"></div>`; }
  protected updated(_changed: PropertyValues) {
    if (!this.isConnected) return;
    this.reactRoot ??= createRoot(this.querySelector(".pi-markdown-root")!);
    this.reactRoot.render(<AgentMarkdown text={this.content} />);
  }
  connectedCallback() { super.connectedCallback(); this.requestUpdate(); }
  disconnectedCallback() {
    super.disconnectedCallback();
    // Finish the outer React/Lit commit before unmounting this independent root.
    queueMicrotask(() => { if (!this.isConnected) { this.reactRoot?.unmount(); this.reactRoot = undefined; } });
  }
}
if (!customElements.get("pm-pi-markdown")) customElements.define("pm-pi-markdown", MarkdownBridge);
