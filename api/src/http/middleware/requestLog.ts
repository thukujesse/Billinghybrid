import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id?: string;
    }
  }
}

/**
 * Assigns each request a correlation id (honoring an inbound X-Request-Id from
 * an upstream gateway), echoes it on the response, and emits one structured
 * JSON log line per request on completion — the shape log aggregators (Loki/
 * ELK) parse natively. Health/readiness/metrics scrapes are not logged to keep
 * the noise down.
 */
const SKIP = new Set(['/health', '/ready', '/metrics']);

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);

  if (SKIP.has(req.path)) return next();

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const line = {
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      msg: 'request',
      id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(ms * 10) / 10,
    };
    console.log(JSON.stringify(line));
  });
  next();
}
