import { useEffect } from 'react';

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Atlas Flow` : 'Atlas Flow';
  }, [title]);
}
