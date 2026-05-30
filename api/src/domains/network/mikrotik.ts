import type { NetworkAdapter, NetworkAction, NetworkContext } from './adapter.js';

/**
 * Mikrotik RouterOS adapter. Maps provisioning actions to the RouterOS API
 * "sentences" they correspond to. This build computes and records the commands
 * (a dry-run plan); wiring the binary API socket (port 8728) is the single
 * remaining step to go live — see connectAndSend() below.
 */

function commandsFor(action: NetworkAction, user: string): string[] {
  switch (action) {
    case 'activate':
      return [
        `/ppp/secret/set [find name="${user}"] disabled=no`,
        `/ip/firewall/address-list/remove [find list=blocked address-list-user="${user}"]`,
      ];
    case 'suspend':
      return [
        `/ppp/secret/set [find name="${user}"] disabled=yes`,
        `/ppp/active/remove [find name="${user}"]`,
        `/ip/firewall/address-list/add list=blocked comment="${user}"`,
      ];
    case 'restore':
      return [
        `/ppp/secret/set [find name="${user}"] disabled=no`,
        `/ip/firewall/address-list/remove [find list=blocked comment="${user}"]`,
      ];
    case 'throttle':
      return [`/queue/simple/set [find name="${user}"] max-limit=512k/512k`];
    case 'unthrottle':
      return [`/queue/simple/set [find name="${user}"] max-limit=0/0`];
  }
}

async function connectAndSend(_ctx: NetworkContext, _commands: string[]): Promise<void> {
  // TODO: open a TCP socket to ctx.router.host:ctx.router.api_port, perform the
  // RouterOS API login handshake, and write each command as length-prefixed
  // words. Left unimplemented so CI never dials a live router.
  throw new Error('RouterOS socket transport not enabled in this build');
}

export const mikrotikAdapter: NetworkAdapter = {
  name: 'mikrotik',
  async apply(action: NetworkAction, ctx: NetworkContext) {
    const user = ctx.pppoeUsername || ctx.subscriberId;
    const commands = commandsFor(action, user);
    const target = ctx.router ? `${ctx.router.host}:${ctx.router.api_port}` : 'unrouted';
    const note = `[mikrotik:${target}] ${action} ${user} :: ${commands.join(' | ')}`;
    console.log(note);
    // Intentionally a dry-run plan — see connectAndSend() to enable live sends.
    void connectAndSend;
    return { ok: true, note };
  },
};
