import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EntityTagEditor } from "./EntityTagEditor";

const apiMocks = vi.hoisted(() => ({
  fileTagOptionUpsert: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

describe("EntityTagEditor", () => {
  it("creates workspace-scoped tags with a null project id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCreated = vi.fn();
    apiMocks.fileTagOptionUpsert.mockResolvedValueOnce({
      id: 7,
      label: "预算",
      colorKey: "amber",
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    });

    render(
      <EntityTagEditor
        projectId={null}
        availableTags={[]}
        tags={[]}
        onChange={onChange}
        onCreated={onCreated}
      />,
    );

    await user.type(screen.getByPlaceholderText("#标签"), "预算{Enter}");

    await waitFor(() => {
      expect(apiMocks.fileTagOptionUpsert).toHaveBeenCalledWith({
        projectId: null,
        label: "预算",
        colorKey: "amber",
      });
    });
    expect(onChange).toHaveBeenCalledWith([7]);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 7, label: "预算" }));
  });
});
