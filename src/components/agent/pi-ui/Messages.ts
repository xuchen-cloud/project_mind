// Adapted from @earendil-works/pi-web-ui 0.75.3. Copyright (c) 2025 Mario Zechner.
// MIT: see LICENSE and UPSTREAM.md. Content ordering and tool-state dispatch retained.
import { html, LitElement, type TemplateResult } from "lit";
import { renderTool } from "./tool-renderer";
import type { PiAssistantMessage, PiToolResultMessage, PiUserMessage, PiContent } from "./types";
import "./MarkdownBridge";

export class UserMessage extends LitElement {
  static properties = { message: { type: Object } };
  declare message: PiUserMessage;
  protected createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.style.display = "block"; }
  render() {
    // Upstream selects the first text block; retain every actual user text block.
    const content = this.message.content.filter(chunk => chunk.type === "text").map(chunk => chunk.text).join("\n");
    return html`<article class="pi-user-message"><div class="pi-message-label">你</div><pm-pi-markdown .content=${content}></pm-pi-markdown></article>`;
  }
}

export class AssistantMessage extends LitElement {
  static properties = { message: { type: Object }, pendingToolCalls: { type: Object }, toolResultsById: { type: Object }, isStreaming: { type: Boolean }, hideToolCalls: { type: Boolean }, hidePendingToolCalls: { type: Boolean } };
  declare message: PiAssistantMessage;
  declare pendingToolCalls?: ReadonlySet<string>;
  declare toolResultsById?: Map<string, PiToolResultMessage>;
  declare isStreaming: boolean;
  declare hideToolCalls: boolean;
  declare hidePendingToolCalls: boolean;
  constructor() { super(); this.isStreaming = false; this.hideToolCalls = false; this.hidePendingToolCalls = false; }
  protected createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.style.display = "block"; }
  render() {
    const orderedParts: TemplateResult[] = [];
    for (const chunk of this.message.content) {
      if (chunk.type === "text" && chunk.text.trim() !== "") {
        orderedParts.push(html`<pm-pi-markdown .content=${chunk.text}></pm-pi-markdown>`);
      } else if (chunk.type === "thinking" && chunk.thinking.trim() !== "") {
        orderedParts.push(html`<details class="pi-thinking"><summary>思考过程</summary><pm-pi-markdown .content=${chunk.thinking}></pm-pi-markdown></details>`);
      } else if (chunk.type === "toolCall" && !this.hideToolCalls) {
        const pending = this.pendingToolCalls?.has(chunk.id) ?? false;
        const result = this.toolResultsById?.get(chunk.id);
        // Upstream avoids displaying pending calls both in stable and streaming views.
        if (this.hidePendingToolCalls && pending && !result) continue;
        const aborted = this.message.stopReason === "aborted" && !result;
        orderedParts.push(html`<pm-pi-tool-message .toolCall=${chunk} .result=${result} .pending=${pending} .aborted=${aborted} .isStreaming=${this.isStreaming}></pm-pi-tool-message>`);
      }
    }
    return html`<article class="pi-assistant-message">
      ${orderedParts.length ? html`<div class="pi-message-parts">${orderedParts}</div>` : ""}
      ${this.message.stopReason === "error" ? html`<p class="pi-tool-error" role="alert">回复生成失败。</p>` : ""}
      ${this.message.stopReason === "aborted" ? html`<p class="pi-message-label">回复已停止。</p>` : ""}
    </article>`;
  }
}

export class ToolMessage extends LitElement {
  static properties = { toolCall: { type: Object }, result: { type: Object }, pending: { type: Boolean }, aborted: { type: Boolean }, isStreaming: { type: Boolean } };
  declare toolCall: Extract<PiContent, { type: "toolCall" }>;
  declare result?: PiToolResultMessage;
  declare pending: boolean;
  declare aborted: boolean;
  declare isStreaming: boolean;
  constructor() { super(); this.pending = false; this.aborted = false; this.isStreaming = false; }
  protected createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.style.display = "block"; }
  render() {
    const rendered = renderTool(this.toolCall.name, this.toolCall.arguments, this.result, !this.aborted && (this.isStreaming || this.pending), this.aborted);
    return rendered.content;
  }
}
/** Pagination can omit the original call; expose the actual result without inventing one. */
export class OrphanToolResult extends LitElement {
  static properties = { result: { type: Object } };
  declare result: PiToolResultMessage;
  protected createRenderRoot() { return this; }
  render() { return renderTool(this.result.toolName ?? "", undefined, this.result, false).content; }
}
for (const [name, element] of [["pm-pi-user-message", UserMessage], ["pm-pi-assistant-message", AssistantMessage], ["pm-pi-tool-message", ToolMessage], ["pm-pi-orphan-tool-result", OrphanToolResult]] as const) {
  if (!customElements.get(name)) customElements.define(name, element);
}
