import { Router } from 'express';
import { createContractsController } from '../controllers/contracts.controller';
import { ContractsService } from '../services/contracts.service';
import { ContractRepository } from '../repositories/contractRepository';
import { getDb } from '../db/database';
import { validateSchema } from '../middleware/validate.middleware';
import { createContractSchema, updateContractSchema } from '../modules/contracts/dto/contract.dto';

/**
 * Creates the contracts router with injected dependencies.
 * DB acquisition happens here at route registration time,
 * not at module import time.
 */
function createContractsRouter(): Router {
  const router = Router();
  const controller = createContractsController(
    new ContractsService(new ContractRepository(getDb())),
  );

  router.get('/bounds', controller.getBounds);
  router.get('/stats', controller.getContractStats);
  router.get('/', controller.getContracts);
  router.get('/:id', controller.getContractById);
  router.post(
    '/',
    validateSchema(createContractSchema),
    controller.createContract,
  );
  router.patch('/:id', validateSchema(updateContractSchema), controller.updateContract);
  router.delete('/:id', controller.deleteContract);

  return router;
}

export default createContractsRouter();