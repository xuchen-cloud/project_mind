import { describe, expect, it } from "vitest";

import { splitTodoUrlText } from "./todo-urls";

describe("Todo URL text", () => {
  it("links complete HTTP(S) URLs without surrounding punctuation", () => {
    expect(
      splitTodoUrlText(
        "资料（https://example.com/a?x=1），备份 https://openai.com/docs。",
      ),
    ).toEqual([
      { type: "text", text: "资料（" },
      { type: "url", text: "https://example.com/a?x=1", href: "https://example.com/a?x=1" },
      { type: "text", text: "），备份 " },
      { type: "url", text: "https://openai.com/docs", href: "https://openai.com/docs" },
      { type: "text", text: "。" },
    ]);
  });

  it("leaves www, email, bare domains, and non-HTTP protocols as plain text", () => {
    const text = "www.example.com a@example.com example.com ftp://example.com";
    expect(splitTodoUrlText(text)).toEqual([{ type: "text", text }]);
  });
});
