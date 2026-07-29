import { describe, expect, it } from "vitest";

import { EMPTY_RICH_EDITOR_HTML } from "./markdown";
import { normalizeRichEditorHtml, normalizeRichEditorValue } from "./normalize";

describe("normalizeRichEditorValue", () => {
  it("trims boundary whitespace from text, markdown, and html", () => {
    expect(
      normalizeRichEditorValue({
        html: "<p></p><p>  首尾空白  </p><p></p>",
        text: "\n  首尾空白  \n",
        markdown: "\n  首尾空白  \n",
      }),
    ).toEqual({
      html: "<p>首尾空白</p>",
      text: "首尾空白",
      markdown: "首尾空白",
    });
  });
});

describe("normalizeRichEditorHtml", () => {
  it("collapses boundary-only blank content to the empty editor html", () => {
    expect(normalizeRichEditorHtml("<p> </p><p></p>")).toBe(EMPTY_RICH_EDITOR_HTML);
  });

  it("preserves embedded image nodes while trimming boundary blanks", () => {
    expect(
      normalizeRichEditorHtml(
        '<p> </p><p><img src="data:image/png;base64,AAAA" data-path="/tmp/demo.png" data-mime-type="image/png" alt="demo"></p><p> </p>',
      ),
    ).toBe(
      '<p><img src="data:image/png;base64,AAAA" data-path="/tmp/demo.png" data-mime-type="image/png" alt="demo"></p>',
    );
  });
});
