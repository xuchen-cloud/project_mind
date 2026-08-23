import { describe, expect, it } from "vitest";

import { useFeedbackStore } from "./feedback-store";

describe("useFeedbackStore", () => {
  it("updates status and manages toast dismissal", () => {
    useFeedbackStore.setState({
      toasts: [],
      status: {
        tone: "neutral",
        label: "Ready",
        message: "等待下一步操作",
      },
    });

    useFeedbackStore.getState().setStatus({
      tone: "success",
      label: "Saved",
      message: "项目摘要已保存",
    });
    useFeedbackStore.getState().pushToast({
      tone: "error",
      title: "失败",
      detail: "mock error",
    });

    const state = useFeedbackStore.getState();
    expect(state.status).toEqual({
      tone: "success",
      label: "Saved",
      message: "项目摘要已保存",
    });
    expect(state.toasts).toHaveLength(1);

    useFeedbackStore.getState().dismissToast(state.toasts[0].id);
    expect(useFeedbackStore.getState().toasts).toHaveLength(0);
  });

  it("keeps one active toast for repeated identical feedback", () => {
    useFeedbackStore.setState({ toasts: [] });

    const feedback = {
      tone: "error" as const,
      title: "保存失败",
      detail: "磁盘不可写",
    };
    useFeedbackStore.getState().pushToast(feedback);
    useFeedbackStore.getState().pushToast(feedback);

    expect(useFeedbackStore.getState().toasts).toHaveLength(1);
  });
});
