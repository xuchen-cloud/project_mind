import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";
export type FeedbackTone = "neutral" | "success" | "warning" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

export interface FeedbackStatus {
  tone: FeedbackTone;
  label: string;
  message: string;
}

const defaultStatus: FeedbackStatus = {
  tone: "neutral",
  label: "Ready",
  message: "等待下一步操作",
};

interface FeedbackStore {
  toasts: ToastItem[];
  status: FeedbackStatus;
  setStatus: (status: Partial<FeedbackStatus>) => void;
  resetStatus: () => void;
  pushToast: (toast: Omit<ToastItem, "id">) => void;
  dismissToast: (id: number) => void;
}

export const useFeedbackStore = create<FeedbackStore>((set) => ({
  toasts: [],
  status: defaultStatus,
  setStatus: (status) =>
    set((state) => ({
      status: {
        ...state.status,
        ...status,
      },
    })),
  resetStatus: () => set({ status: defaultStatus }),
  pushToast: (toast) =>
    set((state) => ({
      toasts: [...state.toasts, { id: Date.now() + Math.round(Math.random() * 1000), ...toast }],
    })),
  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
}));
