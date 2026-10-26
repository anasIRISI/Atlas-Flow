import { create } from 'zustand';
import { WS_PATH, type ClientMessage, type ServerEvent, type WsRoom } from '@flowforge/shared';

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting';

interface WsState {
  status: WsStatus;
  lastEventAt?: number;
}

export const useWsStore = create<WsState>(() => ({ status: 'idle' }));

type Listener = (event: ServerEvent) => void;

/**
 * Single shared WebSocket with automatic reconnect (exponential backoff, max 10 s).
 * Room subscriptions are remembered and replayed after a reconnect.
 */
class WsClient {
  private socket?: WebSocket;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private wanted = false;
  private readonly rooms = new Map<WsRoom, number>();
  private readonly listeners = new Set<Listener>();

  connect(): void {
    this.wanted = true;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    clearTimeout(this.timer);
    useWsStore.setState({ status: this.retry === 0 ? 'connecting' : 'reconnecting' });
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      useWsStore.setState({ status: 'open' });
      for (const room of this.rooms.keys()) this.send({ type: 'subscribe', room });
    };
    socket.onmessage = (msg) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(msg.data)) as ServerEvent;
      } catch {
        return;
      }
      useWsStore.setState({ lastEventAt: Date.now() });
      for (const listener of this.listeners) listener(event);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.wanted) {
        useWsStore.setState({ status: 'idle' });
        return;
      }
      useWsStore.setState({ status: 'reconnecting' });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  disconnect(): void {
    this.wanted = false;
    clearTimeout(this.timer);
    this.retry = 0;
    this.socket?.close();
    this.socket = undefined;
    useWsStore.setState({ status: 'idle' });
  }

  /** Subscribes to a room; returns an unsubscribe function (reference-counted). */
  subscribe(room: WsRoom): () => void {
    const count = this.rooms.get(room) ?? 0;
    this.rooms.set(room, count + 1);
    if (count === 0) this.send({ type: 'subscribe', room });
    return () => {
      const left = (this.rooms.get(room) ?? 1) - 1;
      if (left > 0) this.rooms.set(room, left);
      else {
        this.rooms.delete(room);
        this.send({ type: 'unsubscribe', room });
      }
    };
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

export const wsClient = new WsClient();
