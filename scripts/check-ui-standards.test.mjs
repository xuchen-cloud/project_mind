import { describe, expect, it } from "vitest";
import fs from "node:fs";

import { collectMotionViolations } from "./ui-standards-motion-rules.mjs";

describe("UI motion standards", () => {
  const caretSource = `
:root { --rhythm-caret-blink: 1.1s; }
.rich-editor__text-caret { animation: rich-editor-caret-blink var(--rhythm-caret-blink) step-end infinite; }
@keyframes rich-editor-caret-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .rich-editor__text-caret { animation: none; } }
`;

  it("accepts the caret's existing opacity rhythm and actual stylesheet", () => {
    expect(collectMotionViolations("src/styles/app.css", caretSource)).toEqual([]);
    const css = fs.readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8");
    expect(collectMotionViolations("src/styles/app.css", css)).toEqual([]);
  });

  it.each([
    ["a different source file", (css) => css, "fixture.css"],
    ["a different selector", (css) => css.replaceAll(".rich-editor__text-caret", ".panel")],
    ["a different keyframe", (css) => css.replaceAll("rich-editor-caret-blink", "panel-blink")],
    ["a different cadence", (css) => css.replace("1.1s", "0.2s")],
    ["smooth easing", (css) => css.replace("step-end", "linear")],
    ["finite iterations", (css) => css.replace("infinite", "1")],
    ["transform keyframes", (css) => css.replace("opacity: 0", "transform: scale(.97)")],
    ["missing reduced motion", (css) => css.replace("animation: none;", "color: inherit;")],
    ["an unrelated reduced selector", (css) => css.replace("{ .rich-editor__text-caret { animation: none;", "{ .panel { animation: none;")],
    ["reuse by ordinary transitions", (css) => `${css}\n.panel { transition: opacity var(--rhythm-caret-blink) linear; }`],
  ])("rejects caret rhythm with %s", (_name, change, file = "src/styles/app.css") => {
    expect(collectMotionViolations(file, change(caretSource))).toContainEqual(
      expect.objectContaining({ rule: "caret-rhythm-contract" }),
    );
  });

  it("does not exempt a literal long caret duration or another duration in the caret rule", () => {
    for (const source of [
      caretSource.replace("var(--rhythm-caret-blink)", "1.1s"),
      caretSource.replace("step-end infinite;", "step-end infinite; transition: opacity 1.1s linear;"),
    ]) {
      expect(collectMotionViolations("src/styles/app.css", source)).toContainEqual(
        expect.objectContaining({ rule: "no-long-ui-motion" }),
      );
    }
  });

  it("rejects the retired PPTX inspector layout transition exception", () => {
    const source = `
@container(max-width:800px) {
  .pptx-editor__inspector { transition:max-height var(--duration-standard) var(--ease-out); }
}
@media(prefers-reduced-motion:reduce) { .pptx-editor__inspector { transition:none; } }
`;
    for (const file of ["src/components/office/PptxEditor.tsx", "src/components/office/OtherEditor.tsx"]) {
      expect(collectMotionViolations(file, source)).toContainEqual(
        expect.objectContaining({rule: "no-layout-transition"}),
      );
    }
  });

  it.each([
    ["no-transition-all", '<button className="transition-all" />'],
    ["no-layout-transition", ".row { transition: max-height 160ms ease-in; }"],
    ["no-scale-zero", ".panel { transform: scale(0); }"],
    ["no-ease-in", ".panel { transition: opacity 160ms ease-in; }"],
    ["no-bare-easing", ".panel { transition: opacity var(--duration-standard) ease; }"],
    ["no-long-ui-motion", ".panel { transition: opacity 400ms linear; }"],
    ["no-long-ui-motion", ".panel { animation: drift 1s linear; }"],
    ["no-raw-motion-duration", ".panel { transition: opacity 160ms var(--ease-soft); }"],
    [
      "requires-reduced-motion",
      ".dialog-surface { transition: transform var(--duration-standard) var(--ease-soft); }",
    ],
  ])("reports %s with a line and snippet", (rule, source) => {
    const violation = collectMotionViolations("fixture.css", source).find((item) => item.rule === rule);
    expect(violation).toMatchObject({ file: "fixture.css", line: 1, rule });
    expect(violation?.snippet).toBeTruthy();
  });

  it("accepts tokenized transform motion with a reduced-motion protocol", () => {
    const source = `
.panel { transition: transform var(--duration-standard) var(--ease-soft); }
@starting-style { .panel { transform: scale(.97); } }
@media (prefers-reduced-motion: reduce) { .panel { transform: none; } }
`;
    expect(collectMotionViolations("fixture.css", source)).toEqual([]);
  });

  it("requires reduced motion for every selector with transform transitions", () => {
    const source = `.arbitrary-panel {
  transition: transform var(--duration-standard) var(--ease-soft);
}`;

    expect(collectMotionViolations("fixture.css", source)).toContainEqual(
      expect.objectContaining({ rule: "requires-reduced-motion", snippet: ".arbitrary-panel" }),
    );
  });

  it("does not accept a matching selector outside the reduced-motion block", () => {
    const source = `
.panel { transition: transform var(--duration-standard) var(--ease-soft); }
@media (prefers-reduced-motion: reduce) { .other { transform: none; } }
.panel { color: inherit; }
`;

    expect(collectMotionViolations("fixture.css", source)).toContainEqual(
      expect.objectContaining({ rule: "requires-reduced-motion", snippet: ".panel" }),
    );
  });

  it("limits long-duration exceptions to declared continuous spinner selectors", () => {
    const source = `.spinny-panel { animation: spin 1s linear infinite; }`;

    expect(collectMotionViolations("fixture.css", source)).toContainEqual(
      expect.objectContaining({ rule: "no-long-ui-motion" }),
    );
  });

  it("requires a Tailwind reduced-motion contract for transform transitions", () => {
    const source = `<div className="transition-transform duration-[var(--duration-standard)] translate-y-1" />`;

    expect(collectMotionViolations("fixture.tsx", source)).toContainEqual(
      expect.objectContaining({ rule: "requires-reduced-motion" }),
    );
    expect(
      collectMotionViolations(
        "fixture.tsx",
        '<div className="transition-transform duration-[var(--duration-standard)] translate-y-1 motion-reduce:transform-none" />',
      ).filter((item) => item.rule === "requires-reduced-motion"),
    ).toEqual([]);
  });

  it("connects transform-bearing keyframes to their reduced-motion contract", () => {
    const source = `
.panel { animation: enter var(--duration-standard) var(--ease-soft); }
@keyframes enter { from { transform: translateY(-4px); } }
`;

    expect(collectMotionViolations("fixture.css", source)).toContainEqual(
      expect.objectContaining({ rule: "requires-reduced-motion", snippet: ".panel" }),
    );
  });

  it("checks arbitrary Tailwind animation durations", () => {
    const source = `<div className="animate-[enter_1s_linear]" />`;
    const violations = collectMotionViolations("fixture.tsx", source);

    expect(violations).toContainEqual(expect.objectContaining({ rule: "no-raw-motion-duration" }));
    expect(violations).toContainEqual(expect.objectContaining({ rule: "no-long-ui-motion" }));
  });

  it.each([
    'animate-bounce',
    'animate-[enter_var(--duration-standard)_var(--ease-soft)]',
  ])("requires reduced motion for Tailwind animation class %s", (animationClass) => {
    const source = `<div className="${animationClass}" />`;
    expect(collectMotionViolations("fixture.tsx", source)).toContainEqual(
      expect.objectContaining({ rule: "requires-reduced-motion" }),
    );
    expect(
      collectMotionViolations(
        "fixture.tsx",
        `<div className="${animationClass} motion-reduce:animate-none" />`,
      ).filter((item) => item.rule === "requires-reduced-motion"),
    ).toEqual([]);
  });

  it("does not inspect business timers", () => {
    expect(collectMotionViolations("fixture.ts", "setTimeout(save, 120000);")).toEqual([]);
  });
});
