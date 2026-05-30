import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { parseCommand, isAuthorized, handleCommand, handleUpdate } from '../src/domains/telegram/bot.js';
import { createSubscriber, getSubscriber } from '../src/domains/subscribers/service.js';

const tag = Date.now().toString().slice(-7);
afterAll(async () => { await pool.end(); });

describe('telegram command parsing', () => {
  it('parses a command with args and strips @botname', () => {
    expect(parseCommand('/suspend 254712345678')).toEqual({ command: 'suspend', args: ['254712345678'] });
    expect(parseCommand('/status@JtmBillingBot')).toEqual({ command: 'status', args: [] });
    expect(parseCommand('hello there')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

describe('telegram authorization', () => {
  it('is closed by default (no allowlist configured in tests)', () => {
    expect(isAuthorized('12345')).toBe(false);
  });
});

describe('telegram commands', () => {
  it('/help lists commands', async () => {
    const reply = await handleCommand({ command: 'help', args: [] });
    expect(reply).toContain('/suspend');
    expect(reply).toContain('/balance');
  });

  it('/find, /suspend and /restore act on a subscriber by phone', async () => {
    const phone = `6${tag}55`;
    const sub = await createSubscriber({ full_name: 'TG Target', phone });

    const found = await handleCommand({ command: 'find', args: [phone] });
    expect(found).toContain('TG Target');

    const suspended = await handleCommand({ command: 'suspend', args: [phone] });
    expect(suspended).toContain('Suspended');
    expect((await getSubscriber(sub.id)).status).toBe('suspended');

    const restored = await handleCommand({ command: 'restore', args: [phone] });
    expect(restored).toContain('Restored');
    expect((await getSubscriber(sub.id)).status).toBe('active');
  });

  it('/balance reports the wallet balance', async () => {
    const phone = `6${tag}56`;
    await createSubscriber({ full_name: 'TG Wallet', phone });
    const reply = await handleCommand({ command: 'balance', args: [phone] });
    expect(reply).toContain('KES');
  });

  it('unknown commands are rejected', async () => {
    expect(await handleCommand({ command: 'nuke', args: [] })).toContain('Unknown command');
  });
});

describe('telegram webhook update handling', () => {
  it('ignores updates from unauthorized chats', async () => {
    const res = await handleUpdate({ message: { chat: { id: 999 }, text: '/status' } });
    expect(res.handled).toBe(false);
    expect(res.reply).toBe('Unauthorized.');
  });

  it('ignores non-message / non-command updates', async () => {
    expect((await handleUpdate({})).handled).toBe(false);
  });
});
