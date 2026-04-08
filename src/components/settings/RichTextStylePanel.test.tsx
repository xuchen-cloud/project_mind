import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cloneRichTextStyleSettings,
  DEFAULT_RICH_TEXT_STYLE_SETTINGS,
} from "../../lib/richTextStyle";
import type { RichTextStyleSettings } from "../../lib/types";

const {
  mockRichTextStyleGet,
  mockRichTextStyleUpsert,
  mockSetStatus,
  mockPushToast,
} = vi.hoisted(() => ({
  mockRichTextStyleGet: vi.fn(),
  mockRichTextStyleUpsert: vi.fn(),
  mockSetStatus: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    richTextStyleGet: mockRichTextStyleGet,
    richTextStyleUpsert: mockRichTextStyleUpsert,
  },
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    setStatus: mockSetStatus,
    pushToast: mockPushToast,
  }),
}));

import { RichTextStylePanel } from "./RichTextStylePanel";

let richTextStyleSnapshot: RichTextStyleSettings;

describe("RichTextStylePanel", () => {
  beforeEach(() => {
    mockRichTextStyleGet.mockReset();
    mockRichTextStyleUpsert.mockReset();
    mockSetStatus.mockReset();
    mockPushToast.mockReset();

    richTextStyleSnapshot = cloneRichTextStyleSettings(DEFAULT_RICH_TEXT_STYLE_SETTINGS);
    mockRichTextStyleGet.mockImplementation(async () => richTextStyleSnapshot);
    mockRichTextStyleUpsert.mockImplementation(async (input) => {
      richTextStyleSnapshot = cloneRichTextStyleSettings(input);
      return richTextStyleSnapshot;
    });
  });

  it("auto-saves style changes without rendering a save button", async () => {
    const user = userEvent.setup();

    renderPanel();

    const bodyFontPresetField = (await screen.findAllByRole("combobox"))[0];
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();

    await user.selectOptions(bodyFontPresetField, "source_serif");

    await waitFor(
      () =>
        expect(mockRichTextStyleUpsert.mock.calls[0]?.[0]).toMatchObject({
          body: expect.objectContaining({ fontPreset: "source_serif" }),
        }),
      { timeout: 1500 },
    );

    expect(screen.getAllByText("段距").length).toBeGreaterThan(0);
    expect(screen.getByText("标题字号")).toBeInTheDocument();
  });
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RichTextStylePanel open />
    </QueryClientProvider>,
  );
}
