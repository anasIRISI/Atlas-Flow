import { create } from 'zustand';
import { useAuthStatus } from './auth';
import { toast } from './toast';

export function parseFavorites(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))] : [];
  } catch { return []; }
}

const key = (userId: string) => `atlas.favorites.${userId}`;
const useStore = create<{ byUser: Record<string, string[]> }>(() => ({ byUser: {} }));

function read(userId: string): string[] {
  try { return parseFavorites(localStorage.getItem(key(userId))); } catch { return []; }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null) useStore.setState({ byUser: {} });
    else if (event.key.startsWith('atlas.favorites.')) {
      const userId = event.key.slice('atlas.favorites.'.length);
      useStore.setState((s) => ({ byUser: { ...s.byUser, [userId]: parseFavorites(event.newValue) } }));
    }
  });
}

/** Personal browser preferences: never modifies the workflow or its activation state. */
export function useFavorites() {
  const userId = useAuthStatus().data?.user?.id;
  const stored = useStore((s) => userId ? s.byUser[userId] : undefined);
  const ids = stored ?? (userId ? read(userId) : []);
  const toggle = (id: string) => {
    if (!userId) return;
    const current = useStore.getState().byUser[userId] ?? read(userId);
    const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
    useStore.setState((s) => ({ byUser: { ...s.byUser, [userId]: next } }));
    try { localStorage.setItem(key(userId), JSON.stringify(next)); }
    catch { toast.error('Favori conservé pour cette session', 'Le stockage du navigateur est indisponible.'); }
  };
  return { ids, toggle };
}
