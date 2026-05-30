import { config } from '../../config.js';
import type { NetworkAdapter } from './adapter.js';
import { logAdapter } from './log.js';
import { mikrotikAdapter } from './mikrotik.js';

const adapters: Record<string, NetworkAdapter> = {
  log: logAdapter,
  mikrotik: mikrotikAdapter,
};

/** The adapter selected by NETWORK_DRIVER (default 'log'). */
export function getAdapter(): NetworkAdapter {
  return adapters[config.network.driver] ?? logAdapter;
}

export type { NetworkAdapter, NetworkAction, NetworkContext } from './adapter.js';
