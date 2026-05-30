import { query } from '../../db/pool.js';

/**
 * In-process event bus standing in for Kafka. Events are persisted to the
 * `events` table (append-only) and dispatched to registered handlers. When
 * the system grows, swap this implementation for a real Kafka producer —
 * the call sites (`emit('payment.paid', ...)`) stay unchanged.
 */

export type EventHandler = (payload: Record<string, unknown>) => void | Promise<void>;

const handlers = new Map<string, EventHandler[]>();

export function on(topic: string, handler: EventHandler): void {
  const list = handlers.get(topic) ?? [];
  list.push(handler);
  handlers.set(topic, list);
}

export async function emit(
  topic: string,
  payload: Record<string, unknown>
): Promise<void> {
  await query('INSERT INTO events (topic, payload) VALUES ($1, $2)', [
    topic,
    JSON.stringify(payload),
  ]);

  const list = handlers.get(topic) ?? [];
  for (const handler of list) {
    try {
      await handler(payload);
    } catch (err) {
      // A failing subscriber must not break the publisher. Real Kafka would
      // retry from the consumer offset; here we just log.
      console.error(`[events] handler for "${topic}" failed:`, err);
    }
  }
}
