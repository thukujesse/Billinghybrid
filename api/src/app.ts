import express from 'express';
import cors from 'cors';
import { api } from './http/routes.js';
import { errorHandler } from './http/helpers.js';
import { metricsMiddleware } from './http/middleware/metrics.js';
import { registry } from './lib/metrics.js';
import './domains/events/subscribers.js'; // register event handlers
import './domains/events/metrics.js'; // register metric counters on events

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '12mb' })); // headroom for base64 KYC uploads
  app.use(metricsMiddleware);

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'jtm-billing' }));

  // Prometheus scrape endpoint.
  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(registry.render());
  });

  app.use('/api', api);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
