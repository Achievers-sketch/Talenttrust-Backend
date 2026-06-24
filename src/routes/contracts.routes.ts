import { Router, Request, Response, NextFunction } from 'express';
import { createContractsController } from '../controllers/contracts.controller';
import { ContractsService } from '../services/contracts.service';
import { ContractRepository } from '../repositories/contractRepository';
import { getDb } from '../db/database';
import { validateSchema } from '../middleware/validate.middleware';
import { createContractSchema, updateContractSchema } from '../modules/contracts/dto/contract.dto';
import { eventIngestionService } from '../events/registry';

/**
 * Creates the contracts router with injected dependencies.
 * DB acquisition happens here at route registration time,
 * not at module import time.
 */
function createContractsRouter(): Router {
  const router = Router();
  const db = getDb();
  const repo = new ContractRepository(db);
  const controller = createContractsController(new ContractsService(repo));

  /**
   * Resolves the owner (clientId) of a contract from the DB.
   * Used by requirePermission for ownOnly PATCH and DELETE checks.
   * Returns null when the contract does not exist (triggers 404).
   */
  const getContractOwnerId = async (req: AuthenticatedRequest): Promise<string | null> => {
    const contract = repo.findById(req.params.id ?? '');
    return contract ? contract.clientId : null;
  };

  // GET /bounds — public-facing bounds, still requires auth
  /** @permission contracts:read — admin, client (ownOnly), freelancer (ownOnly) */
  router.get('/bounds', requireAuth, requirePermission('contracts', 'read'), controller.getBounds);

  // GET /stats — aggregate statistics
  /** @permission contracts:list — admin, client (ownOnly), freelancer (ownOnly) */
  router.get('/stats', requireAuth, requirePermission('contracts', 'list'), controller.getContractStats);

  // GET / — list all contracts
  /** @permission contracts:list — admin, client (ownOnly), freelancer (ownOnly) */
  router.get('/', requireAuth, requirePermission('contracts', 'list'), controller.getContracts);

  // GET /:id — fetch single contract
  /** @permission contracts:read — admin, client (ownOnly), freelancer (ownOnly) */
  router.get(
    '/:id',
    requireAuth,
    requirePermission('contracts', 'read', getContractOwnerId),
    controller.getContractById,
  );

  router.get('/bounds', controller.getBounds);
  router.get('/stats', controller.getContractStats);
  router.get('/', controller.getContracts);
  router.get('/:id/history', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const history = await eventIngestionService.getContractHistory(req.params.id);
      res.status(200).json(history);
    } catch (error) {
      next(error);
    }
  });
  router.get('/:id', controller.getContractById);
  router.post(
    '/',
    requireAuth,
    requirePermission('contracts', 'create'),
    validateSchema(createContractSchema),
    controller.createContract,
  );

  // PATCH /:id — update an existing contract (owner or admin only)
  /** @permission contracts:update (ownOnly for client/freelancer) — admin, client, freelancer */
  router.patch(
    '/:id',
    requireAuth,
    requirePermission('contracts', 'update', getContractOwnerId),
    validateSchema(updateContractSchema),
    controller.updateContract,
  );

  // DELETE /:id — delete a contract (admin only per PERMISSION_MATRIX)
  /** @permission contracts:delete — admin only */
  router.delete(
    '/:id',
    requireAuth,
    requirePermission('contracts', 'delete', getContractOwnerId),
    controller.deleteContract,
  );

  return router;
}

export default createContractsRouter();
