import express from 'express';
import cors from 'cors';
import { api } from './http/routes.js';
import { errorHandler } from './http/helpers.js';
import { metricsMiddleware } from './http/middleware/metrics.js';
import { requestLog } from './http/middleware/requestLog.js';
import { tenantMiddleware } from './http/middleware/tenant.js';
import { registry } from './lib/metrics.js';
import { query } from './db/pool.js';
import { registerBuiltinPlugins, loadPlugins } from './plugins/index.js';
import './domains/events/subscribers.js'; // register event handlers
import './domains/events/metrics.js'; // register metric counters on events

export async function createApp() {
  const app = express();
  // The API binds to loopback behind Caddy; SSR (jtm-web) also calls it on
  // loopback. Trust X-Forwarded-* ONLY from loopback so req.hostname reflects
  // the real tenant host (drives Host→tenant routing for server-side renders)
  // and req.ip is the real client (drives per-IP rate limits) — without
  // trusting forwarded headers from any external source.
  app.set('trust proxy', 'loopback');
  app.use(cors());
  app.use(express.json({ limit: '12mb' })); // headroom for base64 KYC uploads
  // MikroTik /tool fetch posts form-encoded data — needed for /routers/identify.
  app.use(express.urlencoded({ extended: false }));
  // Bind the tenant context for the whole request (M1: default tenant).
  // Must run before anything that issues a query().
  app.use(tenantMiddleware);
  app.use(requestLog);
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
