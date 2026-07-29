import { describe, expect, it } from "vitest";

import {
  MAX_RESIDENT_PROJECT_OVERVIEWS,
  pruneResidentProjects,
  touchResidentProject,
} from "./resident-pages";

describe("resident project pages", () => {
  it("keeps the active page and only the two most recent warm pages", () => {
    let resident: number[] = [];
    const open = [1, 2, 3, 4, 5];

    for (const projectId of open) {
      resident = touchResidentProject(resident, projectId, open);
    }

    expect(resident).toEqual([3, 4, 5]);
    expect(resident).toHaveLength(MAX_RESIDENT_PROJECT_OVERVIEWS);
  });

  it("promotes a warm page without remounting it", () => {
    expect(touchResidentProject([1, 2, 3], 1, [1, 2, 3])).toEqual([2, 3, 1]);
  });

  it("drops closed tabs immediately", () => {
    expect(pruneResidentProjects([1, 2, 3], [1, 3])).toEqual([1, 3]);
  });
});
