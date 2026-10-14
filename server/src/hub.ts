import type { WebSocket } from 'ws';
import type { ServerEvent } from '../../shared/api.ts';

const HEARTBEAT_MS = 30_000;

/** Live WebSocket connections per member, for pushing ServerEvents and tracking presence. */
export class Hub {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly alive = new WeakSet<WebSocket>();
  private heartbeat: NodeJS.Timeout | undefined;

  /** Returns true when this is the member's first open connection (they just came online). */
  join(memberId: string, socket: WebSocket): boolean {
    let set = this.sockets.get(memberId);
    const first = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.sockets.set(memberId, set);
    }
    set.add(socket);
    this.alive.add(socket);
    socket.on('pong', () => this.alive.add(socket));
    return first;
  }

  /** Returns true when the member has no connections left (they just went offline). */
  leave(memberId: string, socket: WebSocket): boolean {
    const set = this.sockets.get(memberId);
    if (!set?.delete(socket)) return false;
    if (set.size > 0) return false;
    this.sockets.delete(memberId);
    return true;
  }

  onlineMemberIds(): string[] {
    return [...this.sockets.keys()];
  }

  /** Sends to every connected device, optionally skipping all devices of one member. */
  broadcast(event: ServerEvent, options: { exceptMemberId?: string } = {}): void {
    const data = JSON.stringify(event);
    for (const [memberId, set] of this.sockets) {
      if (memberId !== options.exceptMemberId) deliver(set, data);
    }
  }

  sendToMembers(memberIds: readonly string[], event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const memberId of new Set(memberIds)) {
      const set = this.sockets.get(memberId);
      if (set) deliver(set, data);
    }
  }

  send(socket: WebSocket, event: ServerEvent): void {
    deliver([socket], JSON.stringify(event));
  }

  /** Pings every socket periodically and drops the ones that stopped answering (phones that slept). */
  startHeartbeat(intervalMs = HEARTBEAT_MS): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      for (const set of this.sockets.values()) {
        for (const socket of set) {
          if (!this.alive.has(socket)) {
            socket.terminate();
            continue;
          }
          this.alive.delete(socket);
          socket.ping();
        }
      }
    }, intervalMs);
    this.heartbeat.unref();
  }

  stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

function deliver(sockets: Iterable<WebSocket>, data: string): void {
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}
