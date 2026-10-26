// TelegramHub: ONE getUpdates long-poll loop per bot (baseUrl + token), shared by every subscriber.
// Docs: https://core.telegram.org/bots/api#getupdates  (a bot can be polled by only one client at a time: a second
// concurrent getUpdates makes Telegram answer 409 Conflict, so the hub never has two requests in flight per token).
import { abortableSleep, getMe, telegramCall, TELEGRAM_DEFAULT_BASE_URL, type TelegramAuth } from './telegram.js';
import { IntegrationError } from './errors.js';

export interface TelegramUpdate {
  update_id: number;
  [key: string]: unknown;
}

export interface TelegramSubscription {
  token: string;
  baseUrl?: string;
  /** Offset saved by a previous run (last update_id + 1): continue exactly there. */
  startOffset?: number;
  /** First start without an offset: ignore the messages that are already waiting. */
  skipBacklog: boolean;
  onUpdate(update: TelegramUpdate): void;
  /** Called once per failure streak (409, network down, 5xx…). A 401 is reported once and stops the loop. */
  onError(error: Error): void;
  /** Called with the next offset before a batch is delivered, so it can be saved. */
  onOffset?(nextOffset: number): void;
}

export interface TelegramHubOptions {
  pollTimeoutSeconds: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const ALLOWED_UPDATES = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query'];

interface Poller {
  key: string;
  auth: TelegramAuth;
  subs: Set<TelegramSubscription>;
  abort: AbortController;
  offset: number | undefined;
  /** True once the start sequence is over and the long poll runs. */
  polling: boolean;
  ready: Promise<void>;
  loop: Promise<void>;
  stopping?: Promise<void>;
}

const guard = (fn: () => void) => {
  try {
    fn();
  } catch {
    // A faulty subscriber must not break the others (or the loop).
  }
};

export class TelegramHub {
  private readonly pollers = new Map<string, Poller>();
  private readonly stopping = new Map<string, Promise<void>>();
  private opts: TelegramHubOptions;

  constructor(options: Partial<TelegramHubOptions> = {}) {
    this.opts = { pollTimeoutSeconds: 25, backoffBaseMs: 1000, backoffMaxMs: 60_000, ...options };
  }

  /** Changes the timings (tests make them short). Takes effect at the next request. */
  configure(options: Partial<TelegramHubOptions>): void {
    this.opts = { ...this.opts, ...options };
  }

  get options(): TelegramHubOptions {
    return { ...this.opts };
  }

  /** Number of running poll loops (one per bot). */
  get size(): number {
    return this.pollers.size;
  }

  async subscribe(sub: TelegramSubscription): Promise<{ close(): Promise<void> }> {
    const baseUrl = (sub.baseUrl ?? '').trim() || TELEGRAM_DEFAULT_BASE_URL;
    const key = `${baseUrl}\n${sub.token}`;
    // A loop that is shutting down must be over before a new one starts (never two requests at once).
    while (this.stopping.has(key)) await this.stopping.get(key);

    let poller = this.pollers.get(key);
    if (!poller) {
      poller = this.createPoller(key, { token: sub.token, baseUrl }, sub.startOffset);
      this.pollers.set(key, poller);
    } else if (!poller.polling && sub.startOffset !== undefined) {
      poller.offset = Math.max(poller.offset ?? sub.startOffset, sub.startOffset);
    }
    poller.subs.add(sub);

    try {
      await poller.ready;
    } catch (err) {
      poller.subs.delete(sub);
      if (poller.subs.size === 0) await this.stopPoller(poller);
      throw err;
    }

    const joined = poller;
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        joined.subs.delete(sub);
        if (joined.subs.size === 0) await this.stopPoller(joined);
      },
    };
  }

  private createPoller(key: string, auth: TelegramAuth, offset: number | undefined): Poller {
    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => undefined);
    const poller: Poller = { key, auth, subs: new Set(), abort: new AbortController(), offset, polling: false, ready, loop: Promise.resolve() };
    poller.loop = this.run(poller, resolveReady, rejectReady);
    return poller;
  }

  private stopPoller(poller: Poller): Promise<void> {
    if (poller.stopping) return poller.stopping;
    if (this.pollers.get(poller.key) === poller) this.pollers.delete(poller.key);
    poller.abort.abort();
    const done = poller.loop
      .catch(() => undefined)
      .then(() => {
        if (this.stopping.get(poller.key) === done) this.stopping.delete(poller.key);
      });
    poller.stopping = done;
    this.stopping.set(poller.key, done);
    return done;
  }

  private notifyOffset(poller: Poller) {
    if (poller.offset === undefined) return;
    const offset = poller.offset;
    for (const sub of [...poller.subs]) guard(() => sub.onOffset?.(offset));
  }

  /** getMe → deleteWebhook → (skip backlog) → long poll. */
  private async run(poller: Poller, resolveReady: () => void, rejectReady: (err: unknown) => void): Promise<void> {
    const { signal } = poller.abort;
    try {
      await getMe(poller.auth, { signal });
      await telegramCall(poller.auth, 'deleteWebhook', { drop_pending_updates: false }, { signal, maxRetries: 0 });
      if (poller.offset === undefined && [...poller.subs].some((s) => s.skipBacklog)) {
        const last = await telegramCall<TelegramUpdate[]>(poller.auth, 'getUpdates', { offset: -1, timeout: 0 }, { signal, maxRetries: 0 });
        if (Array.isArray(last) && last.length) {
          poller.offset = Math.max(...last.map((u) => u.update_id)) + 1;
          this.notifyOffset(poller);
        }
      }
    } catch (err) {
      rejectReady(err);
      return;
    }
    poller.polling = true;
    resolveReady();
    await this.pollLoop(poller);
  }

  private async pollLoop(poller: Poller): Promise<void> {
    const { signal } = poller.abort;
    let failures = 0;
    let reported = false;
    while (!signal.aborted) {
      const timeout = this.opts.pollTimeoutSeconds;
      const started = Date.now();
      try {
        const params: Record<string, unknown> = { timeout, limit: 100, allowed_updates: ALLOWED_UPDATES };
        if (poller.offset !== undefined) params.offset = poller.offset;
        const updates = await telegramCall<TelegramUpdate[]>(poller.auth, 'getUpdates', params, { signal, timeoutMs: (timeout + 10) * 1000, maxRetries: 0 });
        if (!Array.isArray(updates)) throw new IntegrationError('Telegram', 'Telegram sent an unexpected answer to getUpdates', { hint: 'Check the Base URL of the Telegram credential.' });
        failures = 0;
        reported = false;
        if (updates.length) {
          poller.offset = Math.max(poller.offset ?? 0, ...updates.map((u) => u.update_id + 1));
          this.notifyOffset(poller);
          for (const update of updates) {
            for (const sub of [...poller.subs]) guard(() => sub.onUpdate(update));
          }
        } else if (timeout >= 1 && Date.now() - started < 100) {
          // A server that answers an empty long poll at once would make this a busy loop.
          await abortableSleep(500, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        const error = err instanceof Error ? err : new Error(String(err));
        if (!reported) {
          reported = true;
          for (const sub of [...poller.subs]) guard(() => sub.onError(error));
        }
        if (error instanceof IntegrationError && error.auth) {
          // The token is wrong: nothing will ever work, stop (and let a new subscriber start a fresh loop).
          if (this.pollers.get(poller.key) === poller) this.pollers.delete(poller.key);
          break;
        }
        const retryAfter = error instanceof IntegrationError ? error.retryAfterMs : undefined;
        const wait = retryAfter ?? Math.min(this.opts.backoffBaseMs * 2 ** failures, this.opts.backoffMaxMs);
        failures++;
        await abortableSleep(wait, signal);
      }
    }
  }
}

export const telegramHub = new TelegramHub();
