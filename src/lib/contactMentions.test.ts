import { describe, expect, it } from "vitest";

import {
  buildContactMentionToken,
  findContactMentionTextTrigger,
  splitContactMentionText,
} from "./contactMentions";

describe("buildContactMentionToken", () => {
  it("serializes a stable token with id and sanitized label", () => {
    expect(buildContactMentionToken({ contactId: 12, label: "张三" })).toBe(
      "@[contact:12|张三]",
    );
  });

  it("replaces label delimiters that would corrupt the token", () => {
    expect(buildContactMentionToken({ contactId: 5, label: "a|b]c" })).toBe(
      "@[contact:5|a b c]",
    );
  });
});

describe("findContactMentionTextTrigger", () => {
  it("detects an @ trigger at the start of the text", () => {
    expect(findContactMentionTextTrigger("@zh", 3)).toEqual({
      start: 0,
      end: 3,
      query: "zh",
    });
  });

  it("detects an @ trigger after whitespace", () => {
    expect(findContactMentionTextTrigger("hi @san", 7)).toEqual({
      start: 3,
      end: 7,
      query: "san",
    });
  });

  it("does not trigger when @ is not word-initial (e.g. email)", () => {
    expect(findContactMentionTextTrigger("user@host", 9)).toBeNull();
  });

  it("stops the trigger once whitespace follows the @", () => {
    expect(findContactMentionTextTrigger("@san done", 9)).toBeNull();
  });
});

describe("splitContactMentionText", () => {
  it("splits text and mention runs", () => {
    const segments = splitContactMentionText("找 @[contact:7|李四] 跟进");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "text", text: "找 " });
    expect(segments[1]).toMatchObject({
      type: "mention",
      mention: { contactId: 7, label: "李四" },
    });
    expect(segments[2]).toEqual({ type: "text", text: " 跟进" });
  });

  it("returns a single text segment when there is no mention", () => {
    expect(splitContactMentionText("plain text")).toEqual([
      { type: "text", text: "plain text" },
    ]);
  });
});
