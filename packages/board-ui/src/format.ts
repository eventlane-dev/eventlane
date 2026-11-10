/** Local date and time with seconds, e.g. `2026-11-10 14:02:07`. */
export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A duration like `850 ms`, `12 s`, `4 min`, `3 h`, `2 d`. */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(abs)} ms`;
  if (abs < 60_000) return `${Math.round(abs / 1000)} s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} h`;
  return `${Math.round(abs / 86_400_000)} d`;
}

/** `5 min ago` or `in 30 s`, relative to now. */
export function formatRelative(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return '-';
  const diff = ms - now;
  return diff >= 0 ? `in ${formatDuration(diff)}` : `${formatDuration(diff)} ago`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / 1024 / 1024).toFixed(1)} MB`;
}
