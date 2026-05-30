import { Router, type Router as RouterType } from 'express';
import { on as busOn } from '../domains/events/bus.js';
import type { Plugin, PluginManifest } from './types.js';

/**
 * Plugin registry. Plugins are registered (built-in or discovered), then
 * loaded once at startup: each enabled plugin gets a scoped event-subscribe
 * function and a Router mounted at /api/ext/<id>. Disabled plugins are
 * recorded but never wired.
 *
 * Enable/disable is controlled by PLUGINS_DISABLED (comma-separated ids) and
 * the manifest's enabledByDefault flag.
 */

interface LoadedPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  routes: number;
  hooks: number;
}

const plugins: Plugin[] = [];
const loaded: LoadedPlugin[] = [];

export function register(plugin: Plugin): void {
  if (plugins.some((p) => p.manifest.id === plugin.manifest.id)) {
    throw new Error(`duplicate plugin id: ${plugin.manifest.id}`);
  }
  plugins.push(plugin);
}

function isEnabled(manifest: PluginManifest): boolean {
  const disabled = (process.env.PLUGINS_DISABLED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (disabled.includes(manifest.id)) return false;
  return manifest.enabledByDefault !== false;
}

/**
 * Load all registered plugins. Returns an Express router holding every enabled
 * plugin's sub-router (mounted by the caller at /api/ext). A failing plugin is
 * isolated — it's marked disabled and never breaks the others or core startup.
 */
export async function loadPlugins(): Promise<RouterType> {
  const extRouter = Router();

  for (const plugin of plugins) {
    const { manifest } = plugin;
    if (!isEnabled(manifest)) {
      loaded.push({ manifest, enabled: false, routes: 0, hooks: 0 });
      continue;
    }

    const router = Router();
    let hooks = 0;
    let routeCount = 0;

    // Count routes the plugin mounts by snapshotting the stack afterward.
    try {
      await plugin.register({
        on: (topic, handler) => { hooks++; busOn(topic, handler); },
        router,
        log: (msg, ...args) => console.log(`[plugin:${manifest.id}] ${msg}`, ...args),
      });
      routeCount = (router.stack ?? []).filter((l: any) => l.route).length;
      extRouter.use(`/${manifest.id}`, router);
      loaded.push({ manifest, enabled: true, routes: routeCount, hooks });
      console.log(`[plugins] loaded ${manifest.id} v${manifest.version} (${hooks} hooks, ${routeCount} routes)`);
    } catch (err) {
      console.error(`[plugins] ${manifest.id} failed to load:`, err);
      loaded.push({ manifest, enabled: false, routes: 0, hooks: 0 });
    }
  }

  return extRouter;
}

/** Snapshot of registered plugins for the admin API. */
export function listPlugins(): LoadedPlugin[] {
  return loaded.map((p) => ({ ...p }));
}

/** Test helper: clear all registration state. */
export function _reset(): void {
  plugins.length = 0;
  loaded.length = 0;
}
