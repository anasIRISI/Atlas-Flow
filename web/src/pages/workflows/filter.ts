import type { WorkflowSummary } from '@flowforge/shared';

export type ActiveFilter = 'all' | 'active' | 'inactive';
export type SortKey = 'updated' | 'name' | 'created';

export interface ListFilters {
  q: string;
  /** Selected tag ids (a workflow must have ALL of them). */
  tags: string[];
  active: ActiveFilter;
  sort: SortKey;
  favorites?: boolean;
}

export function filterWorkflows(list: WorkflowSummary[], f: ListFilters): WorkflowSummary[] {
  const q = f.q.trim().toLowerCase();
  const out = list.filter((w) => {
    if (f.active === 'active' && !w.active) return false;
    if (f.active === 'inactive' && w.active) return false;
    if (f.tags.length && !f.tags.every((id) => w.tags?.some((t) => t.id === id))) return false;
    if (q && !w.name.toLowerCase().includes(q) && !w.tags?.some((t) => t.name.toLowerCase().includes(q))) return false;
    return true;
  });
  const by: Record<SortKey, (a: WorkflowSummary, b: WorkflowSummary) => number> = {
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  };
  return [...out].sort(by[f.sort]);
}

export function readFilters(params: URLSearchParams): ListFilters {
  const active = params.get('active');
  const sort = params.get('sort');
  return {
    q: params.get('q') ?? '',
    tags: (params.get('tags') ?? '').split(',').filter(Boolean),
    active: active === 'active' || active === 'inactive' ? active : 'all',
    sort: sort === 'name' || sort === 'created' ? sort : 'updated',
    favorites: params.get('favorites') === '1',
  };
}

export function writeFilters(f: ListFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.tags.length) p.set('tags', f.tags.join(','));
  if (f.active !== 'all') p.set('active', f.active);
  if (f.sort !== 'updated') p.set('sort', f.sort);
  if (f.favorites) p.set('favorites', '1');
  return p;
}

/** Colour class of the status dot from the last execution status. */
export function statusDot(status: WorkflowSummary['lastExecutionStatus']): { cls: string; label: string } {
  switch (status) {
    case 'success':
      return { cls: 'bg-success', label: 'Last run succeeded' };
    case 'error':
    case 'crashed':
      return { cls: 'bg-danger', label: 'Last run failed' };
    case 'running':
    case 'queued':
    case 'waiting':
      return { cls: 'bg-info', label: 'Running or waiting' };
    case 'canceled':
      return { cls: 'bg-warning', label: 'Last run was canceled' };
    default:
      return { cls: 'bg-line-strong', label: 'Never run' };
  }
}
