import type { NetworkAdapter, NetworkAction, NetworkContext } from './adapter.js';

/** Default adapter: logs the intended action. Safe for dev and CI. */
export const logAdapter: NetworkAdapter = {
  name: 'log',
  async apply(action: NetworkAction, ctx: NetworkContext) {
    const target = ctx.router ? `${ctx.router.name} (${ctx.router.host})` : 'no-router';
    const note = `[log] ${action} -> ${ctx.subscriberId} on ${target}`;
    console.log(note);
    return { ok: true, note };
  },
};
