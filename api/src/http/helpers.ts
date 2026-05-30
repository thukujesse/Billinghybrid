import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { AppError } from '../lib/errors.js';

/** Wrap an async handler so thrown errors reach the error middleware. */
export const ah =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Validate and return a typed request body. */
export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(422).json({ error: 'validation_error', details: err.flatten() });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  // Unique-violation safety net from Postgres.
  if ((err as any)?.code === '23505') {
    res.status(409).json({ error: 'conflict', message: 'resource already exists' });
    return;
  }
  // Log the failure with the request id so a reported error maps to a log line.
  const id = (_req as any).id;
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled_error', id, error: String((err as any)?.message ?? err) }));
  res.status(500).json({ error: 'internal_error', message: 'something went wrong', request_id: id });
}
