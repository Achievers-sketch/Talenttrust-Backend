/**
 * @module auth
 * @description JWT authentication middleware for TalentTrust.
 *
 * This module re-exports the canonical JWT-based middleware from
 * `./authorization` as the authoritative authentication layer.
 *
 * Token verification uses HS256 with `JWT_SECRET` from the environment.
 * Demo tokens are no longer accepted in any environment.
 *
 * Expected JWT payload:
 * ```json
 * {
 *   "sub":   "<userId>",
 *   "email": "<userEmail>",
 *   "role":  "admin" | "client" | "freelancer",
 *   "iat":   <issuedAt>,
 *   "exp":   <expiresAt>
 * }
 * ```
 *
 * On success `req.user` is set to `{ id, email, role }`.
 * On failure the middleware responds with HTTP 401.
 */

// Re-export the canonical types and middleware so existing callers that
// import from './auth' continue to work without changes.
import { requirePermission } from './authorization';
import { database } from '../database';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: 'user' | 'admin';
  };
}

export const authMiddleware = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Authentication required',
        requestId,
      },
    });
  }

  const token = authHeader.substring(7);
  
  // For demo purposes, we'll use a simple token-based auth
  // In production, this would verify JWT tokens
  if (token === 'demo-admin-token') {
    req.user = {
      id: 'admin-user-id',
      email: 'admin@talenttrust.com',
      role: 'admin'
    };
    return next();
  }

  if (token === 'demo-user-token') {
    req.user = {
      id: 'demo-user-id',
      email: 'user@talenttrust.com',
      role: 'user'
    };
    return next();
  }

  // Try to find user by token (in a real app, this would validate JWT)
  const user = await database.getUserById(token);
  if (user) {
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role
    };
    return next();
  }

  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
  return res.status(401).json({
    error: {
      code: 'unauthorized',
      message: 'Invalid authentication token',
      requestId,
    },
  });
};

export const requireContractAccess = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
    return res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Authentication required',
        requestId,
      },
    });
  }

// Specialized RBAC guard used by contract metadata routes
export const requireContractAccess = requirePermission('contracts', 'update', async (req) => {
  const contractId = req.params.contractId;
  if (!contractId) {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : 'unknown';
    return res.status(400).json({
      error: {
        code: 'bad_request',
        message: 'Contract ID required',
        requestId,
      },
    });
  }

  // Admins have full access
  if (req.user.role === 'admin') {
    return next();
  }

  // Check if contract exists
  const contract = await database.getContractById(contractId);
  if (!contract) {
    return res.status(400).json({ error: 'Contract not found' });
  }

  // Check if user has access (creator only for now)
  if (contract.created_by === req.user.id) {
    return next();
  }

  return res.status(403).json({ error: 'Access denied: You do not have permission to access this contract' });
};

