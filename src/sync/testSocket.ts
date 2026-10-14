// Test double for the browser WebSocket (used by socket and chat tests).
import { vi } from 'vitest';

export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readonly url: string;
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('not open');
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  // ---- driven by the test ----
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }));
  }

  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onerror?.(new Event('error'));
    this.onclose?.(new CloseEvent('close', { code: 1006 }));
  }

  /** The server closes the connection on purpose, with `code`. */
  closeFromServer(code: number) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code }));
  }

  static latest(): FakeSocket {
    const s = FakeSocket.instances.at(-1);
    if (!s) throw new Error('no socket was opened');
    return s;
  }
}

export function installFakeSocket() {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
}
