import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageLoadingSkeleton } from "./PageLoadingSkeleton";

describe("PageLoadingSkeleton", () => {
  it.each(["overview", "record"] as const)("renders an accessible static %s shell", (variant) => {
    const { container } = render(
      <PageLoadingSkeleton variant={variant} label="正在加载内容" testId="page-skeleton" />,
    );

    const status = screen.getByRole("status", { name: "正在加载内容" });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("data-variant", variant);
    expect(screen.getByTestId("page-skeleton")).toBe(status);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector(".animate-spin, .spin")).toBeNull();
  });
});
