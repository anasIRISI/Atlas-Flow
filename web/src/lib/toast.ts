import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push(toast: Omit<Toast, 'id'>, ttlMs?: number): void;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push(toast, ttlMs = 4500) {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttlMs);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const toast = {
  success: (title: string, message?: string) => useToasts.getState().push({ kind: 'success', title, message }),
  error: (title: string, message?: string) => useToasts.getState().push({ kind: 'error', title, message }, 8000),
  info: (title: string, message?: string) => useToasts.getState().push({ kind: 'info', title, message }),
};
