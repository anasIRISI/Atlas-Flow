export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'à l’instant';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `il y a ${days} j` : new Date(iso).toLocaleDateString();
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
