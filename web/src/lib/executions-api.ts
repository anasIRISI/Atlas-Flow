import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExecutionDetail, ExecutionListQuery, ExecutionPage, PruneResult, RetryExecutionRequest } from '@flowforge/shared';
import { api } from './api';

export const executionsKey = ['executions'] as const;

const list = (v: unknown) => (Array.isArray(v) ? v.join(',') : v === undefined ? '' : String(v));

export function executionsQueryString(q: ExecutionListQuery): string {
  const params = new URLSearchParams();
  for (const key of ['workflowId', 'status', 'mode', 'from', 'to', 'limit', 'cursor'] as const) {
    const value = list(q[key]);
    if (value) params.set(key, value);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const fetchExecutions = (q: ExecutionListQuery = {}) => api<ExecutionPage>(`/executions${executionsQueryString(q)}`);

/** Cursor-paginated list ("Load more"); polls every 5 s while something is queued or running. */
export function useExecutionPages(filters: Omit<ExecutionListQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: [...executionsKey, 'list', filters],
    queryFn: ({ pageParam }) => fetchExecutions({ ...filters, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages ?? [];
      return pages.some((p) => p.items.some((e) => e.status === 'queued' || e.status === 'running')) ? 5000 : false;
    },
  });
}

export function useExecution(id: string | undefined) {
  return useQuery({
    queryKey: [...executionsKey, 'detail', id],
    queryFn: () => api<ExecutionDetail>(`/executions/${id}`),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.status ?? '') ? 2000 : false),
  });
}

export function useDeleteExecutions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api<{ deleted: number }>('/executions/delete', { method: 'POST', body: { ids } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: executionsKey }),
  });
}

export function useRetryExecution() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & RetryExecutionRequest) =>
      api<{ executionId: string }>(`/executions/${id}/retry`, { method: 'POST', body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: executionsKey }),
  });
}

export function usePruneExecutions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<PruneResult>('/executions/prune', { method: 'POST', body: {} }),
    onSuccess: () => void client.invalidateQueries({ queryKey: executionsKey }),
  });
}
