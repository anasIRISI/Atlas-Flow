import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ExecutionDetail,
  ImportWorkflowResponse,
  Tag,
  RunWorkflowRequest,
  TestListenRequest,
  TestListenResponse,
  WorkflowData,
  WorkflowRecord,
  WorkflowSummary,
} from '@flowforge/shared';
import { api } from './api';

export const workflowsKey = ['workflows'] as const;

export function useWorkflows() {
  return useQuery({ queryKey: workflowsKey, queryFn: () => api<WorkflowSummary[]>('/workflows') });
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: ['workflow', id],
    queryFn: () => api<WorkflowRecord>(`/workflows/${id}`),
    enabled: Boolean(id),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });
}

export function useCreateWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<WorkflowData> = {}) => api<WorkflowRecord>('/workflows', { method: 'POST', body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: workflowsKey }),
  });
}

export function useRenameWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api<WorkflowRecord>(`/workflows/${id}`, { method: 'PATCH', body: { name } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: workflowsKey }),
  });
}

export function useDeleteWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/workflows/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: workflowsKey }),
  });
}

export const saveWorkflow = (id: string, data: WorkflowData, versionNote?: string) =>
  api<WorkflowRecord>(`/workflows/${id}`, { method: 'PUT', body: versionNote ? { ...data, versionNote } : data });

export const runWorkflow = (body: RunWorkflowRequest) => api<{ executionId: string }>('/executions/run', { method: 'POST', body });

export const stopExecution = (id: string) => api<{ stopped: boolean }>(`/executions/${id}/stop`, { method: 'POST' });

export const fetchExecution = (id: string) => api<ExecutionDetail>(`/executions/${id}`);

export const activateWorkflow = (id: string) => api<WorkflowRecord>(`/workflows/${id}/activate`, { method: 'POST', body: {} });

export const deactivateWorkflow = (id: string) => api<WorkflowRecord>(`/workflows/${id}/deactivate`, { method: 'POST', body: {} });

export const testListen = (id: string, body: TestListenRequest) => api<TestListenResponse>(`/workflows/${id}/test-listen`, { method: 'POST', body });

export const cancelTestListen = (id: string) => api<{ stopped: boolean }>(`/workflows/${id}/test-listen`, { method: 'DELETE' });

export function useToggleActive() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => (active ? activateWorkflow(id) : deactivateWorkflow(id)),
    onSettled: () => void client.invalidateQueries({ queryKey: workflowsKey }),
  });
}

// ── Phase 7: tags, duplicate, import / export, bulk delete ──
export const tagsKey = ['tags'] as const;

export function useTags() {
  return useQuery({ queryKey: tagsKey, queryFn: () => api<Tag[]>('/tags') });
}

export function useTagMutations() {
  const client = useQueryClient();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: tagsKey });
    void client.invalidateQueries({ queryKey: workflowsKey });
  };
  return {
    create: useMutation({ mutationFn: (name: string) => api<Tag>('/tags', { method: 'POST', body: { name } }), onSuccess: refresh }),
    rename: useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api<Tag>(`/tags/${id}`, { method: 'PATCH', body: { name } }), onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: string) => api<void>(`/tags/${id}`, { method: 'DELETE' }), onSuccess: refresh }),
    assign: useMutation({
      mutationFn: ({ id, tagIds }: { id: string; tagIds: string[] }) => api<{ tags: Array<{ id: string; name: string }> }>(`/workflows/${id}/tags`, { method: 'PUT', body: { tagIds } }),
      onSuccess: refresh,
    }),
  };
}

export function useDuplicateWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<WorkflowRecord>(`/workflows/${id}/duplicate`, { method: 'POST', body: {} }),
    onSuccess: () => void client.invalidateQueries({ queryKey: workflowsKey }),
  });
}

export function useImportWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (workflow: unknown) => api<ImportWorkflowResponse>('/workflows/import', { method: 'POST', body: workflow }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: workflowsKey });
      void client.invalidateQueries({ queryKey: tagsKey });
    },
  });
}

export function useBulkDelete() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api<{ deleted: number }>('/workflows/delete', { method: 'POST', body: { ids } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: workflowsKey });
      void client.invalidateQueries({ queryKey: tagsKey });
    },
  });
}

/** Downloads the export file of a workflow (the server sets the file name). */
export async function downloadWorkflowExport(id: string, fallbackName: string): Promise<void> {
  const res = await fetch(`/api/workflows/${id}/export`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
  const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] ?? `${fallbackName}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
