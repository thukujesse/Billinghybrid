import type { Request, Response, NextFunction } from 'express';
import { config } from '../../config.js';
import { verifyJwt } from '../../lib/jwt.js';
import type { Role } from '../../domains/auth/service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { sub: string; role: Role; [k: string]: unknown };
    }
  }
}

/**
 * RBAC guard. When auth is disabled (demo mode) it injects a synthetic admin
 * so existing flows work unchanged. When enabled, it requires a valid bearer
 * token and — if roles are listed — one of those roles.
 */
export function requireAuth(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.auth.enabled) {
      req.user = { sub: 'dev-admin', role: 'admin' };
      return next();
    }

    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? verifyJwt(token, config.auth.jwtSecret) : null;
    if (!claims) {
      res.status(401).json({ error: 'unauthorized', message: 'missing or invalid token' });
      return;
    }
    if (roles.length && !roles.includes(claims.role as Role)) {
      res.status(403).json({ error: 'forbidden', message: `requires role: ${roles.join(', ')}` });
      return;
    }
    req.user = { ...claims, sub: claims.sub, role: claims.role as Role };
    next();
  };
}
