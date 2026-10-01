// @vitest-environment node
import { expect, it } from "vitest";
import { handleSourceExtractionRequest } from "./source-extraction-worker";
const frame = (format: string, text: string) => ({ requestId: "source-fixture", format, base64: Buffer.from(text).toString("base64") });

it("only accepts known formats as strings and rejects unrelated capabilities", async () => {
  for (const request of [{ ...frame("text", "visible"), format: ["text"] }, { ...frame("text", "visible"), path: "/private/secret" }, { ...frame("text", "visible"), maxChars: 99 }, { ...frame("text", "visible"), format: "javascript" }]) {
    expect(await handleSourceExtractionRequest(request)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
  }
});

it("rejects noncanonical base64 rather than silently decoding a different source", async () => {
  for (const base64 of ["YQ", "YQ===", "YQ==\n", "YR==", "=YQ=", "Y Q="]) {
    expect(await handleSourceExtractionRequest({ requestId: "bad", format: "text", base64 })).toMatchObject({ ok: false });
  }
});

it("returns empty and mixed UTF-8 sources without filesystem or network input", async () => {
  expect(await handleSourceExtractionRequest(frame("text", ""))).toMatchObject({ ok: true, data: { state: "ready", chunks: [], coverage: { complete: true } } });
  expect(await handleSourceExtractionRequest(frame("markdown", "# 中文 evidence"))).toMatchObject({ requestId: "source-fixture", ok: true, data: { state: "ready", chunks: [{ text: "中文 evidence" }] } });
});
