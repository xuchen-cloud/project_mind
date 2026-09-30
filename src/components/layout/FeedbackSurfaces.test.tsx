import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useFeedbackStore } from "../../state/feedback-store";
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

  it("keeps the save retry action in an error toast", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<ToastStack toasts={[{
      id: 1,
      tone: "error",
      title: "后台保存失败",
      action: { label: "重试保存", onClick: onRetry },
    }]} onDismiss={onDismiss} />);

    await user.click(screen.getByRole("button", { name: "重试保存" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledWith(1);
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


it("expires ordinary notices independently after four seconds and retains errors/actions", () => {
  vi.useFakeTimers();
  try {
    const onDismiss = vi.fn();
    const first = { id: 11, tone: "info" as const, title: "已复制" };
    const second = { id: 12, tone: "success" as const, title: "导出成功" };
    const persistent = [
      { id: 13, tone: "error" as const, title: "保存失败" },
      { id: 14, tone: "info" as const, title: "已删除", action: { label: "撤销", onClick: vi.fn() } },
    ];
    const { rerender, unmount } = render(<ToastStack toasts={[first, ...persistent]} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(2000));
    rerender(<ToastStack toasts={[first, second, ...persistent]} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(1999));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss.mock.calls).toEqual([[11]]);
    act(() => vi.advanceTimersByTime(2000));
    expect(onDismiss.mock.calls).toEqual([[11], [12]]);
    rerender(<ToastStack toasts={[...persistent, { id: 15, tone: "info", title: "即将关闭" }]} onDismiss={onDismiss} />);
    unmount();
    act(() => vi.advanceTimersByTime(10000));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
