import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("keeps dismissed toast visuals for 160ms without repeating live-region semantics", () => {
    vi.useFakeTimers();
    const toast = { id: 1, tone: "error" as const, title: "保存失败" };
    const { rerender } = render(<ToastStack toasts={[toast]} onDismiss={vi.fn()} />);

    rerender(<ToastStack toasts={[]} onDismiss={vi.fn()} />);

    const closingToast = document.querySelector(".toast-item") as HTMLElement;
    expect(closingToast).toHaveAttribute("data-state", "closing");
    expect(closingToast).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(160));
    expect(document.querySelector(".toast-item")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("finishes a Toast exit on transitionend before the safety timer", () => {
    vi.useFakeTimers();
    const toast = { id: 1, tone: "neutral" as const, title: "已保存" };
    const { rerender } = render(<ToastStack toasts={[toast]} onDismiss={vi.fn()} />);

    rerender(<ToastStack toasts={[]} onDismiss={vi.fn()} />);
    const closingToast = document.querySelector(".toast-item") as HTMLElement;
    fireEvent.transitionEnd(closingToast);

    expect(document.querySelector(".toast-item")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(160));
    expect(document.querySelector(".toast-item")).not.toBeInTheDocument();
  });

  it("keeps new Toasts during an exit and cancels the exit when the same id returns", () => {
    vi.useFakeTimers();
    const first = { id: 1, tone: "neutral" as const, title: "第一条" };
    const second = { id: 2, tone: "success" as const, title: "第二条" };
    const { rerender } = render(<ToastStack toasts={[first]} onDismiss={vi.fn()} />);

    rerender(<ToastStack toasts={[]} onDismiss={vi.fn()} />);
    rerender(<ToastStack toasts={[second]} onDismiss={vi.fn()} />);

    expect(document.querySelectorAll(".toast-item")).toHaveLength(2);
    expect(screen.getByText("第二条").closest(".toast-item")).toHaveAttribute(
      "data-state",
      "present",
    );

    rerender(<ToastStack toasts={[first, second]} onDismiss={vi.fn()} />);
    expect(screen.getByText("第一条").closest(".toast-item")).toHaveAttribute(
      "data-state",
      "present",
    );

    act(() => vi.advanceTimersByTime(160));
    expect(document.querySelectorAll(".toast-item")).toHaveLength(2);
  });
});
