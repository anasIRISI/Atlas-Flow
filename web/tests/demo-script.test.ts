import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WAIT_MS,
  STEP_COUNT,
  buildToast,
  demoReducer,
  initialDemo,
  parseWaitMs,
  shouldSimulate,
  summarizeResults,
  type DemoAction,
  type DemoState,
} from '../src/demo/demo-script';

const run = (actions: DemoAction[], from: DemoState = initialDemo()) => actions.reduce(demoReducer, from);

describe('demo state machine', () => {
  it('starts at step 1 and walks through the 5 steps to finished', () => {
    let s = run([{ type: 'start' }]);
    expect(s).toMatchObject({ phase: 'running', step: 0 });
    for (let i = 1; i < STEP_COUNT; i++) {
      s = demoReducer(s, { type: 'next' });
      expect(s.step).toBe(i);
    }
    s = demoReducer(s, { type: 'next' });
    expect(s.phase).toBe('finished');
  });

  it('skip behaves like next; stop ends the demo and nothing moves afterwards', () => {
    let s = run([{ type: 'start' }, { type: 'skip' }, { type: 'skip' }]);
    expect(s.step).toBe(2);
    s = demoReducer(s, { type: 'stop' });
    expect(s.phase).toBe('stopped');
    expect(demoReducer(s, { type: 'next' })).toEqual(s);
    expect(demoReducer(s, { type: 'fallback', note: 'x' })).toEqual(s);
  });

  it('ignores actions while idle; stop while idle stays idle', () => {
    expect(demoReducer(initialDemo(), { type: 'next' })).toEqual(initialDemo());
    expect(demoReducer(initialDemo(), { type: 'stop' }).phase).toBe('idle');
  });

  it('records each fallback once and remembers a simulated submission', () => {
    const s = run([{ type: 'start' }, { type: 'fallback', note: 'Showcase workflow' }, { type: 'fallback', note: 'Showcase workflow' }, { type: 'fallback', note: 'Simulating a submission', simulatedSubmission: true }]);
    expect(s.fallbacks).toEqual(['Showcase workflow', 'Simulating a submission']);
    expect(s.simulatedSubmission).toBe(true);
  });

  it('start again after stop resets everything', () => {
    const s = run([{ type: 'start' }, { type: 'next' }, { type: 'stop' }, { type: 'start' }]);
    expect(s).toMatchObject({ phase: 'running', step: 0, fallbacks: [] });
  });
});

describe('helpers', () => {
  it('shouldSimulate after the wait', () => {
    expect(shouldSimulate(19_999)).toBe(false);
    expect(shouldSimulate(DEFAULT_WAIT_MS)).toBe(true);
    expect(shouldSimulate(600, 500)).toBe(true);
  });
  it('parseWaitMs accepts sane values only', () => {
    expect(parseWaitMs('500')).toBe(500);
    expect(parseWaitMs(null)).toBe(DEFAULT_WAIT_MS);
    expect(parseWaitMs('abc')).toBe(DEFAULT_WAIT_MS);
    expect(parseWaitMs('-5')).toBe(DEFAULT_WAIT_MS);
    expect(parseWaitMs('9999999')).toBe(DEFAULT_WAIT_MS);
  });
  it('buildToast labels', () => {
    expect(buildToast('gemini')).toBe('Built with Gemini');
    expect(buildToast('offline')).toBe('Offline: closest template');
    expect(buildToast('showcase')).toBe('Showcase workflow');
  });
});

describe('summarizeResults', () => {
  const workflow = {
    nodes: [
      { name: 'W', type: 'flowforge.openMeteo' },
      { name: 'M', type: 'flowforge.sendEmail' },
      { name: 'T', type: 'flowforge.telegram' },
      { name: 'D', type: 'flowforge.discord' },
    ],
  };
  const ok = { status: 'success' };
  it('sent / simulated / failed / did not run', () => {
    const rows = summarizeResults({
      status: 'success',
      workflow,
      runData: { W: [ok], M: [{ status: 'success', simulated: true }], T: [{ status: 'error', error: { message: 'chat not found' } }] },
    });
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['weather', 'sent'],
      ['email', 'simulated'],
      ['telegram', 'failed'],
      ['discord', 'skipped'],
    ]);
    expect(rows[2]!.text).toContain('chat not found');
    expect(rows[1]!.text).toContain('simulated');
  });
  it('handles a missing detail and workflows without integrations', () => {
    expect(summarizeResults(undefined)).toEqual([]);
    expect(summarizeResults({ status: 'success', workflow: { nodes: [] }, runData: {} })).toEqual([]);
    expect(summarizeResults({ status: 'error', workflow: { nodes: [] }, runData: {} })[0]!.status).toBe('failed');
  });
});
