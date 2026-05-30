import type { Router } from 'express';
import type { EventHandler } from '../domains/events/bus.js';

/**
 * Plugin contract. A plugin extends the system without modifying core code:
 * it subscribes to domain events and/or mounts routes under /api/ext/<id>.
 * This mirrors PHPNuxBill's plugin model on a typed, event-driven core.
 */

export interface PluginManifest {
  id: string;            // unique slug, e.g. "loyalty-points"
  name: string;
  version: string;
  description?: string;
  /** Default enabled state if not overridden by config/db. */
  enabledByDefault?: boolean;
}

export interface PluginContext {
  /** Subscribe to a domain event topic (same bus the core uses). */
  on: (topic: string, handler: EventHandler) => void;
  /** A router mounted at /api/ext/<plugin-id> when the plugin loads. */
  router: Router;
  /** Structured logger scoped to the plugin. */
  log: (msg: string, ...args: unknown[]) => void;
}

export interface Plugin {
  manifest: PluginManifest;
  /** Called once at startup when the plugin is enabled. */
  register: (ctx: PluginContext) => void | Promise<void>;
}
