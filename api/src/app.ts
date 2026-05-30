import express from 'express';
import cors from 'cors';
import { api } from './http/routes.js';
import { errorHandler } from './http/helpers.js';
import './domains/events/subscribers.js'; // register event handlers

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '12mb' })); // headroom for base64 KYC uploads

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'jtm-billing' }));
  app.use('/api', api);

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
