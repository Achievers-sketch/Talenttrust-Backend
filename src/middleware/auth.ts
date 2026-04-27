import { Request, Response, NextFunction } from 'express';
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
    return res.status(401).json({ error: 'Authentication required' });
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

  return res.status(401).json({ error: 'Invalid authentication token' });
};

export const requireContractAccess = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const contractId = req.params.contractId;
  if (!contractId) {
    return res.status(400).json({ error: 'Contract ID required' });
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

