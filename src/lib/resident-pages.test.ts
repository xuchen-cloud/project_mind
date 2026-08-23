import { describe, expect, it } from "vitest";

import {
  MAX_RESIDENT_PROJECT_OVERVIEWS,
  pruneResidentProjects,
  touchResidentProject,
} from "./resident-pages";

describe("resident project pages", () => {
  it("keeps one active Project and the four most recent Warm Projects", () => {
    let resident: number[] = [];
    const open = [1, 2, 3, 4, 5, 6];

    for (const projectId of open.slice(0, 5)) {
      resident = touchResidentProject(resident, projectId, open);
    }

    expect(resident).toEqual([1, 2, 3, 4, 5]);
    expect(resident).toHaveLength(MAX_RESIDENT_PROJECT_OVERVIEWS);

    resident = touchResidentProject(resident, 1, open);
    expect(resident).toEqual([2, 3, 4, 5, 1]);

    resident = touchResidentProject(resident, 6, open);
    expect(resident).toEqual([3, 4, 5, 1, 6]);
  });

  it("promotes a warm page without remounting it", () => {
    expect(touchResidentProject([1, 2, 3, 4, 5], 1, [1, 2, 3, 4, 5])).toEqual([
      2, 3, 4, 5, 1,
    ]);
  });

  it("drops closed tabs immediately", () => {
    expect(pruneResidentProjects([1, 2, 3], [1, 3])).toEqual([1, 3]);
  });

  it("stays bounded after a long Project history", () => {
    const open = Array.from({ length: 40 }, (_, index) => index + 1);
    const resident = open.reduce<number[]>(
      (current, projectId) => touchResidentProject(current, projectId, open),
      [],
    );

    expect(resident).toEqual([36, 37, 38, 39, 40]);
    expect(resident).toHaveLength(MAX_RESIDENT_PROJECT_OVERVIEWS);
  });
});
