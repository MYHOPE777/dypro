import type { LiveCommand, LiveEvent, LiveSessionSnapshot } from '../shared/v2';
import type { Product } from '../shared/types';
import type { V2ClientFrame, V2ServerFrame } from '../shared/v2Protocol';

export type LiveSessionClientOptions = { roomId: string; sessionId?: string; displayAlias?: string; role: 'operator' | 'display'; presenterId?: string; url?: string };
export type LiveSessionClientListener = (snapshot: LiveSessionSnapshot, event?: LiveEvent) => void;

function nextId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class LiveSessionClient {
  readonly products: Product[] = [];
  private readonly options: LiveSessionClientOptions;
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private disposed = false;
  private connectedValue = false;
  private snapshotValue: LiveSessionSnapshot | null = null;
  private readonly listeners = new Set<LiveSessionClientListener>();
  private readonly statusListeners = new Set<(status: string) => void>();
  private readonly pending: Array<{ requestId: string; command: LiveCommand }> = [];

  constructor(options: LiveSessionClientOptions) {
    this.options = options;
  }

  get snapshot(): LiveSessionSnapshot | null { return this.snapshotValue; }
  get connected(): boolean { return this.connectedValue; }

  subscribe(listener: LiveSessionClientListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onStatus(listener: (status: string) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }

  connect(): void {
    if (this.disposed || this.socket) return;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    this.setStatus('正在连接');
    const url = this.options.url ?? `${protocol}://${window.location.host}/ws/v2`;
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      this.connectedValue = true;
      this.setStatus('已连接');
      this.sendFrame({ type: 'session.join', roomId: this.options.roomId, ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}), ...(this.options.displayAlias ? { displayAlias: this.options.displayAlias } : {}), role: this.options.role, actorId: this.options.role === 'display' ? 'local-display' : 'local-operator', ...(this.options.presenterId ? { presenterId: this.options.presenterId } : {}) });
    };
    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return;
      let frame: V2ServerFrame;
      try { frame = JSON.parse(message.data) as V2ServerFrame; } catch { return; }
      if (frame.type === 'ready') {
        this.products.splice(0, this.products.length, ...frame.products);
        this.snapshotValue = frame.snapshot;
        this.options.sessionId = frame.sessionId;
        this.notify(frame.snapshot);
      } else if (frame.type === 'event') {
        if (!this.snapshotValue || frame.event.sequence <= this.snapshotValue.latestSequence) return;
        this.snapshotValue = frame.snapshot;
        this.notify(frame.snapshot, frame.event);
      } else if (frame.type === 'error') {
        this.setStatus(frame.message);
      }
    };
    socket.onclose = () => {
      this.connectedValue = false;
      this.socket = null;
      if (!this.disposed) {
        this.setStatus('连接中断，正在重试');
        this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, 1_000);
      }
    };
    socket.onerror = () => this.setStatus('连接暂时不可用');
  }

  send(command: LiveCommand): boolean {
    const requestId = nextId();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pending.push({ requestId, command });
      return false;
    }
    this.sendFrame(command, requestId);
    return true;
  }

  sendAudio(pcm: ArrayBuffer | Uint8Array): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.options.role === 'display') return false;
    const payload = pcm instanceof ArrayBuffer ? pcm : new Uint8Array(pcm).buffer as ArrayBuffer;
    this.socket.send(payload);
    return true;
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = null;
    this.connectedValue = false;
  }

  private sendFrame(command: V2ClientFrame['command'], requestId = nextId()): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ requestId, command } satisfies V2ClientFrame));
    if (command.type === 'session.join') {
      while (this.pending.length > 0) {
        const queued = this.pending.shift()!;
        this.socket.send(JSON.stringify({ requestId: queued.requestId, command: queued.command } satisfies V2ClientFrame));
      }
    }
  }

  private notify(snapshot: LiveSessionSnapshot, event?: LiveEvent): void { for (const listener of this.listeners) listener(snapshot, event); }
  private setStatus(status: string): void { for (const listener of this.statusListeners) listener(status); }
}
