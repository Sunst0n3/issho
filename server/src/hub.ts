import type { WebSocket } from 'ws';
import { WS_CLOSE_UNPAIRED, type ServerEvent } from '../../shared/api.ts';

export { WS_CLOSE_UNPAIRED };

const HEARTBEAT_MS = 30_000;
/**
 * How often open sockets are checked against the devices table. A phone revoked or removed with
 * the admin CLI (another process) is cut off within this long, even when nothing is broadcast.
 */
const PAIRING_CHECK_MS = 5_000;

export interface HubOptions {
  /**
   * Whether a device (its token hash) is still paired. Checked before every delivery and every
   * few seconds, so a phone revoked or removed with the admin CLI (another process) stops
   * receiving the household's events at once.
   */
  isPaired?: (tokenHash: string) => boolean;
}

/** Live WebSocket connections per member, for pushing ServerEvents and tracking presence. */
export class Hub {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly devices = new WeakMap<WebSocket, string>();
  private readonly isPaired: (tokenHash: string) => boolean;
  private heartbeat: NodeJS.Timeout | undefined;
  private pairingCheck: NodeJS.Timeout | undefined;

  constructor(options: HubOptions = {}) {
    this.isPaired = options.isPaired ?? (() => true);
  }

  /**
   * Adds a socket opened with the device token `tokenHash`. Returns true when this is the
   * member's first open connection (they just came online).
   */
  join(memberId: string, socket: WebSocket, tokenHash: string): boolean {
    let set = this.sockets.get(memberId);
    const first = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.sockets.set(memberId, set);
    }
    set.add(socket);
    this.alive.add(socket);
    this.devices.set(socket, tokenHash);
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
      if (memberId !== options.exceptMemberId) this.deliver(set, data);
    }
  }

  sendToMembers(memberIds: readonly string[], event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const memberId of new Set(memberIds)) {
      const set = this.sockets.get(memberId);
      if (set) this.deliver(set, data);
    }
  }

  send(socket: WebSocket, event: ServerEvent): void {
    this.deliver([socket], JSON.stringify(event));
  }

  /** Closes the sockets of a device that was just signed out. */
  closeDevice(tokenHash: string): void {
    for (const set of this.sockets.values()) {
      for (const socket of set) {
        if (this.devices.get(socket) === tokenHash) unpaired(socket);
      }
    }
  }

  /** Closes every socket whose device is no longer paired. */
  checkPairings(): void {
    for (const set of this.sockets.values()) {
      for (const socket of set) this.stillPaired(socket);
    }
  }

  /**
   * Pings every socket periodically and drops the ones that stopped answering (phones that
   * slept); checks more often that every socket's device is still paired.
   */
  startHeartbeat(intervalMs = HEARTBEAT_MS, pairingCheckMs = PAIRING_CHECK_MS): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      for (const set of this.sockets.values()) {
        for (const socket of set) {
          if (!this.alive.has(socket)) {
            socket.terminate();
            continue;
          }
          if (!this.stillPaired(socket)) continue;
          this.alive.delete(socket);
          socket.ping();
        }
      }
    }, intervalMs);
    this.heartbeat.unref();
    this.pairingCheck = setInterval(() => this.checkPairings(), pairingCheckMs);
    this.pairingCheck.unref();
  }

  stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    clearInterval(this.pairingCheck);
    this.heartbeat = undefined;
    this.pairingCheck = undefined;
  }

  private deliver(sockets: Iterable<WebSocket>, data: string): void {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN && this.stillPaired(socket)) socket.send(data);
    }
  }

  /** False (after closing it) when the socket's device was signed out or removed. */
  private stillPaired(socket: WebSocket): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    const tokenHash = this.devices.get(socket);
    if (tokenHash !== undefined && this.isPaired(tokenHash)) return true;
    unpaired(socket);
    return false;
  }
}

function unpaired(socket: WebSocket): void {
  if (socket.readyState === socket.OPEN) socket.close(WS_CLOSE_UNPAIRED, 'device not paired');
}
