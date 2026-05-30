/**
 * NetworkAdapter — the seam between billing decisions and the actual network.
 * Provisioning calls these methods; an implementation turns them into router
 * commands (Mikrotik RouterOS API, FreeRADIUS CoA, etc.).
 */

export interface NetworkContext {
  subscriberId: string;
  pppoeUsername?: string | null;
  router?: {
    id: string;
    name: string;
    host: string;
    api_port: number;
    type: string;
  } | null;
  detail?: Record<string, unknown>;
}

export type NetworkAction = 'activate' | 'suspend' | 'restore' | 'throttle' | 'unthrottle';

export interface NetworkAdapter {
  readonly name: string;
  apply(action: NetworkAction, ctx: NetworkContext): Promise<{ ok: boolean; note: string }>;
}
