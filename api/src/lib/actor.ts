/**
 * Request-scoped actor context via AsyncLocalStorage.
 *
 * The audit log needs to know who performed each mutation, but the
 * service layer doesn't have direct access to req.user. Rather than
 * thread an `actor` parameter through every function signature (and
 * every call site), we stash the actor in ALS at the requireAuth
 * middleware boundary and read it back wherever logAudit() runs.
 *
 * For non-HTTP contexts (cron workers, startup tasks), call
 * runAsActor({ id: 'system', label: 'system', role: 'system' }, fn).
 * Anywhere outside an ALS scope, currentActor() returns the system
 * actor by default — never throws, never blocks legitimate mutations.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Actor {
  id: string;
  label: string;          // username for staff; customer_id for customer; "system" for cron
  role: string;           // 'admin' | 'staff' | 'customer' | 'subscriber' | 'system'
}

const SYSTEM_ACTOR: Actor = { id: 'system', label: 'system', role: 'system' };

const als = new AsyncLocalStorage<Actor>();

export function runAsActor<T>(actor: Actor, fn: () => T): T {
  return als.run(actor, fn);
}

export function currentActor(): Actor {
  return als.getStore() ?? SYSTEM_ACTOR;
}
