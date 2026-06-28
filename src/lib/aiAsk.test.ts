import { describe, expect, it } from "vitest";

import { deriveAskScopeContext } from "./aiAsk";

describe("deriveAskScopeContext", () => {
  it("uses project scope defaults on activity routes", () => {
    expect(deriveAskScopeContext("/projects/1/activities/2", 1, 2)).toEqual({
      defaultScope: "project",
      allowedScopes: ["project", "workspace"],
    });
  });

  it("uses project scope defaults on project routes", () => {
    expect(deriveAskScopeContext("/projects/1", 1, null)).toEqual({
      defaultScope: "project",
      allowedScopes: ["project", "workspace"],
    });
  });

  it("uses workspace scope defaults outside project routes", () => {
    expect(deriveAskScopeContext("/today", null, null)).toEqual({
      defaultScope: "workspace",
      allowedScopes: ["workspace"],
    });
  });
});
