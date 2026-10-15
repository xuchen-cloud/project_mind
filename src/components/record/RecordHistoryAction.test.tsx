import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RecordHistoryAction } from "./RecordHistoryAction";
import { recordDocumentApi } from "../../services/recordDocumentApi";
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { editorsFlush: vi.fn(), checkpoint: vi.fn() } }));
it("keeps history closed when an editor cannot flush", async () => {
  vi.mocked(recordDocumentApi.editorsFlush).mockRejectedValue(new Error("EDITOR_BUSY"));
  render(<RecordHistoryAction binding={{ workspaceId: "workspace", generation: "opened" }} target={{ scope: { kind: "workspace" }, recordId: 7 }} onRestored={vi.fn()} />);
  fireEvent.click(screen.getByRole("button",{ name: "版本历史" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("EDITOR_BUSY");
  expect(recordDocumentApi.checkpoint).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button",{ name: "版本历史" })).toBeEnabled());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
