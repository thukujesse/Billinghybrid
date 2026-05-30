import { config } from '../../config.js';
import { sendTelegram } from '../notifications/telegram.js';
import { listSubscribers, suspendSubscriber, restoreSubscriber } from '../subscribers/service.js';
import { getOrCreateWallet, getWallet, credit } from '../wallet/service.js';
import { dashboard } from '../reports/service.js';
import { formatMoney, toCents } from '../../lib/money.js';

/**
 * Telegram admin bot — handles rich commands from authorized chats. Mirrors
 * the architecture doc's "Bot with rich commands (suspend, top-up)".
 *
 * Commands:
 *   /help
 *   /status                 system snapshot
 *   /find <phone>           look up a subscriber
 *   /suspend <phone>        suspend a subscriber
 *   /restore <phone>        restore a subscriber
 *   /balance <phone>        wallet balance
 *   /topup <phone> <amount> credit a subscriber wallet (KES)
 */

export interface ParsedCommand {
  command: string;
  args: string[];
}

/** Parse a message into a command + args. Strips a leading slash and any
 *  @botname suffix (group chats append it). Returns null for non-commands. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const command = parts[0].slice(1).split('@')[0].toLowerCase();
  return { command, args: parts.slice(1) };
}

/** Is this chat allowed to issue commands? */
export function isAuthorized(chatId: string | number): boolean {
  const allow = config.telegram.adminChatIds;
  if (allow.length === 0) return false; // closed by default
  return allow.includes(String(chatId));
}

async function findByPhone(phone: string) {
  const all = await listSubscribers();
  return all.find((s) => s.phone === phone || s.phone.endsWith(phone));
}

/** Execute a parsed command and return the reply text. */
export async function handleCommand(cmd: ParsedCommand): Promise<string> {
  switch (cmd.command) {
    case 'start':
    case 'help':
      return [
        'JTM Billing admin bot. Commands:',
        '/status — system snapshot',
        '/find <phone> — look up a subscriber',
        '/suspend <phone> — suspend a subscriber',
        '/restore <phone> — restore a subscriber',
        '/balance <phone> — wallet balance',
        '/topup <phone> <amount> — credit a wallet (KES)',
      ].join('\n');

    case 'status': {
      const d = await dashboard();
      const subs = d.subscribers as Record<string, number>;
      return [
        '<b>System status</b>',
        `Active: ${subs.active ?? 0}  Suspended: ${subs.suspended ?? 0}  Pending: ${subs.pending ?? 0}`,
        `Revenue: ${formatMoney(d.revenue.total_cents)} (${d.revenue.payments} payments)`,
      ].join('\n');
    }

    case 'find': {
      if (!cmd.args[0]) return 'Usage: /find <phone>';
      const sub = await findByPhone(cmd.args[0]);
      if (!sub) return 'No subscriber found.';
      return `${sub.full_name} (${sub.phone})\nType: ${sub.type}  Status: ${sub.status}  KYC: ${sub.kyc_status}`;
    }

    case 'suspend': {
      if (!cmd.args[0]) return 'Usage: /suspend <phone>';
      const sub = await findByPhone(cmd.args[0]);
      if (!sub) return 'No subscriber found.';
      await suspendSubscriber(sub.id, 'telegram-admin');
      return `Suspended ${sub.full_name} (${sub.phone}).`;
    }

    case 'restore': {
      if (!cmd.args[0]) return 'Usage: /restore <phone>';
      const sub = await findByPhone(cmd.args[0]);
      if (!sub) return 'No subscriber found.';
      await restoreSubscriber(sub.id);
      return `Restored ${sub.full_name} (${sub.phone}).`;
    }

    case 'balance': {
      if (!cmd.args[0]) return 'Usage: /balance <phone>';
      const sub = await findByPhone(cmd.args[0]);
      if (!sub) return 'No subscriber found.';
      const w = await getWallet('subscriber', sub.id);
      return `${sub.full_name}: ${formatMoney(w?.balance_cents ?? 0)}`;
    }

    case 'topup': {
      if (!cmd.args[0] || !cmd.args[1]) return 'Usage: /topup <phone> <amount>';
      const amount = Number(cmd.args[1]);
      if (!Number.isFinite(amount) || amount <= 0) return 'Amount must be a positive number.';
      const sub = await findByPhone(cmd.args[0]);
      if (!sub) return 'No subscriber found.';
      const w = await getOrCreateWallet('subscriber', sub.id);
      const updated = await credit(w.id, toCents(amount), 'Admin top-up (Telegram)', { type: 'topup' });
      return `Topped up ${sub.full_name} by ${formatMoney(toCents(amount))}. New balance: ${formatMoney(updated.balance_cents)}.`;
    }

    default:
      return 'Unknown command. Send /help.';
  }
}

/**
 * Process an incoming Telegram webhook update: authorize the chat, parse the
 * command, run it, and reply. Returns a short status for logging/tests.
 */
export async function handleUpdate(update: any): Promise<{ handled: boolean; reply?: string }> {
  const message = update?.message ?? update?.edited_message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (!chatId || !text) return { handled: false };

  if (!isAuthorized(chatId)) {
    if (!config.telegram.simulated) await sendTelegram(String(chatId), 'Unauthorized.');
    return { handled: false, reply: 'Unauthorized.' };
  }

  const cmd = parseCommand(text);
  if (!cmd) return { handled: false };

  const reply = await handleCommand(cmd);
  if (!config.telegram.simulated) {
    await sendTelegram(String(chatId), reply);
  } else {
    console.log(`[telegram-bot] ${cmd.command} -> ${reply.split('\n')[0]}`);
  }
  return { handled: true, reply };
}
