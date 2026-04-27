import { Router } from 'express';
import { ContractsController } from '../controllers/contracts.controller';
import { validateSchema } from '../middleware/validate.middleware';
import { createContractSchema, updateContractSchema } from '../modules/contracts/dto/contract.dto';

const router = Router();

router.get('/bounds', ContractsController.getBounds);
router.get('/stats', ContractsController.getContractStats);

const contractsService = new ContractsService(new ContractRepository(getDb()));

const contractOwnerResolver = async (req: any) => {
  const contract = await contractsService.getContractById(req.params.id);
  if (!contract) return null;
  if (req.user?.role === 'admin') return req.user.id;
  if (contract.clientId === req.user?.id || contract.freelancerId === req.user?.id) return req.user.id;
  return 'not-owner';
};

const selfResolver = async (req: any) => req.user?.id || null;

const uuidParamSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

router.get('/bounds', requirePermission('contracts', 'read', selfResolver), ContractsController.getBounds);
router.get('/stats', requirePermission('contracts', 'list', selfResolver), ContractsController.getContractStats);
router.get('/', requirePermission('contracts', 'list', selfResolver), ContractsController.getContracts);
router.get('/:id', validateSchema(uuidParamSchema), requirePermission('contracts', 'read', contractOwnerResolver), ContractsController.getContractById);

router.post(
  '/',
  requirePermission('contracts', 'create'),
  validateSchema(createContractSchema),
  ContractsController.createContract,
);

// OCC-aware update: validate version field before delegating to controller
router.patch('/:id', validateSchema(updateContractSchema), ContractsController.updateContract);

router.delete('/:id', ContractsController.deleteContract);

export default router;
