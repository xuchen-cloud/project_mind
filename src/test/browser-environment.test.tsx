import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

it("matches relational CSS around Tailwind arbitrary classes without breaking accessible queries", () => {
  render(<>
    <style>{`.environment-split:has(>button:first-child:disabled) { opacity: 0.5; }`}</style>
    <button className="rounded-[var(--radius-8)]">打开设置</button>
    <div className="environment-split" data-testid="split"><button disabled>保存</button></div>
  </>);

  expect(screen.getByRole("button", { name: "打开设置" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(getComputedStyle(screen.getByTestId("split")).opacity).toBe("0.5");
});
