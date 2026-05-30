import type { Request, Response, NextFunction } from 'express';
import { httpRequests, httpDuration } from '../../lib/metrics.js';

/**
 * Records request count + latency per method/route/status. Uses the matched
 * route path (e.g. /subscribers/:id) rather than the raw URL so label
 * cardinality stays bounded.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = (req.route?.path as string) || req.path || 'unknown';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequests.inc(labels);
    httpDuration.observe(seconds, { route });
  });
  next();
}
