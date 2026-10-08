// Adapted from @earendil-works/pi-web-ui 0.75.3. Copyright (c) 2025 Mario Zechner.
// MIT: see LICENSE and UPSTREAM.md. Original setMessage RAF batching/deep clone retained.
import { html, LitElement } from "lit";
import type { PiMessage, PiToolResultMessage } from "./types";
import "./Messages";
export class StreamingMessageContainer extends LitElement {
  static properties = { isStreaming: { type: Boolean }, pendingToolCalls: { type: Object }, toolResultsById: { type: Object }, _message: { state: true } };
  declare isStreaming: boolean;
  declare pendingToolCalls?: ReadonlySet<string>;
  declare toolResultsById?: Map<string, PiToolResultMessage>;
  declare private _message: PiMessage | null;
  private _pendingMessage: PiMessage | null = null;
  private _updateScheduled = false;
  private _frame: number | null = null;
  constructor() { super(); this.isStreaming = false; this._message = null; }
  protected createRenderRoot() { return this; }
  connectedCallback() { super.connectedCallback(); this.style.display = "block"; }
  setMessage(message: PiMessage | null, immediate = false) {
    this._pendingMessage = message;
    if (immediate || message === null) {
      if (this._frame !== null) cancelAnimationFrame(this._frame);
      this._frame = null;
      this._message = message;
      this.requestUpdate();
      this._pendingMessage = null;
      this._updateScheduled = false;
      return;
    }
    if (!this._updateScheduled) {
      this._updateScheduled = true;
      this._frame = requestAnimationFrame(() => {
        this._frame = null;
        if (this._pendingMessage !== null) {
          this._message = JSON.parse(JSON.stringify(this._pendingMessage));
          this.requestUpdate();
        }
        this._pendingMessage = null;
        this._updateScheduled = false;
      });
    }
  }
  disconnectedCallback() { super.disconnectedCallback(); this.setMessage(null, true); }
  render() {
    if (!this._message) return this.isStreaming ? html`<span class="pi-stream-cursor" aria-hidden="true"></span>` : html``;
    const msg = this._message;
    if (msg.role === "toolResult" || msg.role === "user") return html``;
    return html`<div class="pi-stream-message"><pm-pi-assistant-message .message=${msg} .isStreaming=${this.isStreaming} .pendingToolCalls=${this.pendingToolCalls} .toolResultsById=${this.toolResultsById} .hideToolCalls=${false}></pm-pi-assistant-message>${this.isStreaming ? html`<span class="pi-stream-cursor" aria-hidden="true"></span>` : ""}</div>`;
  }
}
if (!customElements.get("pm-pi-stream")) customElements.define("pm-pi-stream", StreamingMessageContainer);
