// Demo Mode script: a pure state machine + result summary. No React, no network. Contract: docs/phase8-contracts.md (W3)

export const DEMO_STEPS = ['Build', 'QR code', 'Submission', 'Run', 'Results'] as const;
export const STEP_COUNT = DEMO_STEPS.length;
/** Wait for a real submission this long, then simulate one. */
export const DEFAULT_WAIT_MS = 20_000;

export type DemoPhase = 'idle' | 'running' | 'finished' | 'stopped';

export interface DemoState {
  phase: DemoPhase;
  /** 0-based index into DEMO_STEPS. */
  step: number;
  /** Narration shown in the overlay. */
  narration: string;
  /** Which fallbacks were used (shown as small notes). */
  fallbacks: string[];
  /** The submission was made by Demo Mode, not by a person. */
  simulatedSubmission: boolean;
}

export type DemoAction =
  | { type: 'start' }
  /** The current step finished (or was skipped). */
  | { type: 'next' }
  | { type: 'skip' }
  | { type: 'stop' }
  /** A fallback was used; the script goes on. */
  | { type: 'fallback'; note: string; simulatedSubmission?: boolean }
  | { type: 'narrate'; text: string };

export const NARRATION: readonly string[] = [
  'The AI Workflow Builder turns a sentence into a workflow.',
  'Scan this QR code with your phone to open the form.',
  'Waiting for someone to fill in the form...',
  'The workflow runs: watch the data flow through the nodes.',
  'Done. Here is what happened.',
];

export const initialDemo = (): DemoState => ({ phase: 'idle', step: 0, narration: '', fallbacks: [], simulatedSubmission: false });

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'start':
      return { phase: 'running', step: 0, narration: NARRATION[0]!, fallbacks: [], simulatedSubmission: false };
    case 'next':
    case 'skip': {
      if (state.phase !== 'running') return state;
      if (state.step >= STEP_COUNT - 1) return { ...state, phase: 'finished', narration: 'Demo finished.' };
      const step = state.step + 1;
      return { ...state, step, narration: NARRATION[step]! };
    }
    case 'stop':
      return state.phase === 'idle' ? state : { ...state, phase: 'stopped', narration: 'Demo stopped.' };
    case 'fallback':
      if (state.phase !== 'running') return state;
      return {
        ...state,
        fallbacks: state.fallbacks.includes(action.note) ? state.fallbacks : [...state.fallbacks, action.note],
        simulatedSubmission: state.simulatedSubmission || action.simulatedSubmission === true,
      };
    case 'narrate':
      return state.phase === 'running' ? { ...state, narration: action.text } : state;
  }
}

export const isActive = (s: DemoState) => s.phase === 'running';

/** True when the wait for a real submission is over. */
export const shouldSimulate = (elapsedMs: number, waitMs = DEFAULT_WAIT_MS) => elapsedMs >= waitMs;

/** Toast shown after the build: what produced the workflow. */
export function buildToast(source: 'gemini' | 'offline' | 'showcase'): string {
  return source === 'gemini' ? 'Built with Gemini' : source === 'offline' ? 'Offline: closest template' : 'Showcase workflow';
}

/** `?demoWait=ms` (tests): how long to wait for a real submission. Anything else gives the default. */
export function parseWaitMs(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 120_000 ? Math.round(n) : DEFAULT_WAIT_MS;
}

// ── Results card ──

export type ResultStatus = 'sent' | 'simulated' | 'failed' | 'skipped';

export interface ResultRow {
  id: 'weather' | 'email' | 'telegram' | 'discord';
  label: string;
  status: ResultStatus;
  text: string;
}

interface RunLike {
  status: string;
  simulated?: boolean;
  error?: { message?: string };
  data?: { main?: Array<Array<{ json?: Record<string, unknown> }>> };
}
export interface DetailLike {
  status?: string;
  workflow?: { nodes?: Array<{ name: string; type: string }> };
  runData?: Record<string, RunLike[]>;
}

const KINDS: Array<{ id: ResultRow['id']; type: string; label: string; ok: string }> = [
  { id: 'weather', type: 'flowforge.openMeteo', label: 'Weather fetched', ok: 'Weather fetched' },
  { id: 'email', type: 'flowforge.sendEmail', label: 'Email', ok: 'Email sent' },
  { id: 'telegram', type: 'flowforge.telegram', label: 'Telegram', ok: 'Telegram message sent' },
  { id: 'discord', type: 'flowforge.discord', label: 'Discord', ok: 'Discord message posted' },
];

/** One line per integration: sent / simulated (no key) / failed (reason) / did not run. */
export function summarizeResults(detail: DetailLike | undefined | null): ResultRow[] {
  const rows: ResultRow[] = [];
  if (!detail) return rows;
  for (const kind of KINDS) {
    const nodes = (detail.workflow?.nodes ?? []).filter((n) => n.type === kind.type);
    if (!nodes.length) continue;
    const runs = nodes.flatMap((n) => detail.runData?.[n.name] ?? []);
    const last = runs[runs.length - 1];
    if (!last) {
      const why = detail.status === 'error' ? 'The run stopped before this step' : 'This step did not run';
      rows.push({ id: kind.id, label: kind.label, status: 'skipped', text: why });
      continue;
    }
    if (last.simulated) rows.push({ id: kind.id, label: kind.label, status: 'simulated', text: `${kind.ok.replace(/ (sent|posted|fetched)$/, '')}: simulated (no key)` });
    else if (last.status === 'error') rows.push({ id: kind.id, label: kind.label, status: 'failed', text: `${kind.label} failed: ${last.error?.message ?? 'unknown error'}` });
    else rows.push({ id: kind.id, label: kind.label, status: 'sent', text: kind.ok });
  }
  if (!rows.length && detail.status === 'error') rows.push({ id: 'weather', label: 'Run', status: 'failed', text: 'The run failed' });
  return rows;
}

export const RESULT_SYMBOL: Record<ResultStatus, string> = { sent: '✓', simulated: '⚠', failed: '✗', skipped: '–' };
