import { create } from "zustand";

type ToastTone = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

interface AppStore {
  selectedProjectId: number | null;
  createProjectOpen: boolean;
  createActivityOpen: boolean;
  activeTodoId: number | null;
  projectComposer: "conclusion" | "todo" | null;
  toasts: ToastItem[];
  setSelectedProjectId: (id: number | null) => void;
  setCreateProjectOpen: (open: boolean) => void;
  setCreateActivityOpen: (open: boolean) => void;
  setActiveTodoId: (id: number | null) => void;
  setProjectComposer: (value: "conclusion" | "todo" | null) => void;
  pushToast: (toast: Omit<ToastItem, "id">) => void;
  dismissToast: (id: number) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  selectedProjectId: null,
  createProjectOpen: true,
  createActivityOpen: false,
  activeTodoId: null,
  projectComposer: null,
  toasts: [],
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  setCreateProjectOpen: (createProjectOpen) => set({ createProjectOpen }),
  setCreateActivityOpen: (createActivityOpen) => set({ createActivityOpen }),
  setActiveTodoId: (activeTodoId) => set({ activeTodoId }),
  setProjectComposer: (projectComposer) => set({ projectComposer }),
  pushToast: (toast) =>
    set((state) => ({
      toasts: [...state.toasts, { id: Date.now() + Math.round(Math.random() * 1000), ...toast }],
    })),
  dismissToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
}));
