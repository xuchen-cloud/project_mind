import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFeedbackStore } from "../../state/feedback-store";
import { StatusBar } from "./StatusBar";
import { ToastStack } from "./ToastStack";

describe("feedback surfaces", () => {
  beforeEach(() => {
    useFeedbackStore.setState({
      toasts: [],
      status: { tone: "neutral", label: "Ready", message: "等待下一步操作" },
    });
  });

  it("announces errors assertively and lets the user dismiss a toast", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(
      <ToastStack
        toasts={[{ id: 1, tone: "error", title: "保存失败", detail: "磁盘不可写" }]}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("保存失败磁盘不可写");
    await user.click(screen.getByRole("button", { name: "关闭通知：保存失败" }));
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it("uses a polite live region for normal status and an alert for an error", () => {
    const { rerender } = render(<StatusBar />);
    expect(screen.getByRole("status")).toHaveTextContent("等待下一步操作");

    act(() => {
      useFeedbackStore.getState().setStatus({
        tone: "error",
        label: "Failed",
        message: "同步失败",
      });
    });
    rerender(<StatusBar />);

    expect(screen.getByRole("alert")).toHaveTextContent("同步失败");
  });
});
