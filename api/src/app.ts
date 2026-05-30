import express from 'express';
import cors from 'cors';
import { api } from './http/routes.js';
import { errorHandler } from './http/helpers.js';
import { metricsMiddleware } from './http/middleware/metrics.js';
import { registry } from './lib/metrics.js';
import { query } from './db/pool.js';
import { registerBuiltinPlugins, loadPlugins } from './plugins/index.js';
import './domains/events/subscribers.js'; // register event handlers
import './domains/events/metrics.js'; // register metric counters on events

export async function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '12mb' })); // headroom for base64 KYC uploads
  app.use(metricsMiddleware);

  // Liveness: the process is up. Cheap, never touches dependencies — a failing
  // liveness probe restarts the pod, which a transient DB blip should not do.
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'jtm-billing' }));

  // Readiness: can the app actually serve requests? Verifies DB connectivity.
  // A failing readiness probe pulls the pod out of the Service (no traffic)
  // without restarting it.
  app.get('/ready', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Prometheus scrape endpoint.
  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(registry.render());
  });

  app.use('/api', api);

  // Load plugins and mount their routers under /api/ext/<plugin-id>.
  registerBuiltinPlugins();
  const extRouter = await loadPlugins();
  app.use('/api/ext', extRouter);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
