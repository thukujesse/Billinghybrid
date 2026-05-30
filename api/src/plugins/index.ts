import { register, loadPlugins, listPlugins } from './registry.js';
import { loyaltyPointsPlugin } from './builtin/loyaltyPoints.js';

/**
 * Register built-in plugins here. Third-party plugins would be discovered from
 * a plugins directory or an npm-style package list and registered the same way.
 */
export function registerBuiltinPlugins(): void {
  register(loyaltyPointsPlugin);
}

export { loadPlugins, listPlugins };
