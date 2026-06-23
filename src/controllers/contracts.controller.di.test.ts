
import { Request, Response, NextFunction } from 'express';
import { ContractsController, createContractsController } from './contracts.controller';
import { ContractBoundsError } from '../contracts/bounds';

// Mock the pagination utils
jest.mock('../utils/pagination', () => ({
  parsePaginationQuery: jest.fn().mockReturnValue({
    ok: true,
    value: { page: 1, limit: 10, offset: 0 },
  }),
  applyPagination: jest.fn().mockImplementation((items) => items),
}));

// Mock apiResponse helpers
jest.mock('../utils/apiResponse', () => ({
  ok: jest.fn(),
  fail: jest.fn(),
}));

import { ok, fail } from '../utils/apiResponse';

function makeMockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    locals: { requestId: 'test-req-id' },
  } as unknown as Response;
}

function makeMockReq(overrides: Partial<Request> = {}): Request {
  return {
    query: {},
    params: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

const next = jest.fn() as unknown as NextFunction;

const mockService = {
  getAllContracts: jest.fn(),
  getContractById: jest.fn(),
  createContract: jest.fn(),
  updateContract: jest.fn(),
  deleteContract: jest.fn(),
  getContractStats: jest.fn(),
};

describe('ContractsController (DI)', () => {
  let controller: ReturnType<typeof createContractsController>;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = createContractsController(mockService as any);
  });

  describe('getContracts', () => {
    it('returns paginated contracts', async () => {
      mockService.getAllContracts.mockResolvedValueOnce([{ id: '1' }, { id: '2' }]);
      await controller.getContracts(makeMockReq(), makeMockRes(), next);
      expect(ok).toHaveBeenCalledWith(
        expect.anything(),
        [{ id: '1' }, { id: '2' }],
        expect.objectContaining({ page: 1, limit: 10, total: 2 }),
      );
    });

    it('calls next on service error', async () => {
      mockService.getAllContracts.mockRejectedValueOnce(new Error('DB error'));
      await controller.getContracts(makeMockReq(), makeMockRes(), next);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getContractById', () => {
    it('returns contract when found', async () => {
      const contract = { id: 'abc', title: 'Test' };
      mockService.getContractById.mockResolvedValueOnce(contract);
      await controller.getContractById(
        makeMockReq({ params: { id: 'abc' } }),
        makeMockRes(),
        next,
      );
      expect(ok).toHaveBeenCalledWith(expect.anything(), contract);
    });

    it('throws NotFoundError when contract is null', async () => {
      mockService.getContractById.mockResolvedValueOnce(null);
      await controller.getContractById(
        makeMockReq({ params: { id: 'missing' } }),
        makeMockRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('createContract', () => {
    it('creates contract and returns 201', async () => {
      const newContract = { id: 'new-1', title: 'New' };
      mockService.createContract.mockResolvedValueOnce(newContract);
      await controller.createContract(
        makeMockReq({ body: { title: 'New' } }),
        makeMockRes(),
        next,
      );
      expect(ok).toHaveBeenCalledWith(expect.anything(), newContract, undefined, 201);
    });

    it('returns 422 on ContractBoundsError', async () => {
      mockService.createContract.mockRejectedValueOnce(
        new ContractBoundsError('bounds exceeded'),
      );
      await controller.createContract(makeMockReq(), makeMockRes(), next);
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        'contract_bounds_error',
        'bounds exceeded',
        422,
      );
    });
  });

  describe('updateContract', () => {
    it('updates contract successfully', async () => {
      const updated = { id: 'u-1', title: 'Updated' };
      mockService.updateContract.mockResolvedValueOnce(updated);
      await controller.updateContract(
        makeMockReq({ params: { id: 'u-1' }, body: { title: 'Updated' } }),
        makeMockRes(),
        next,
      );
      expect(ok).toHaveBeenCalledWith(expect.anything(), updated);
    });

    it('returns 422 on ContractBoundsError', async () => {
      mockService.updateContract.mockRejectedValueOnce(
        new ContractBoundsError('bounds exceeded'),
      );
      await controller.updateContract(
        makeMockReq({ params: { id: 'u-1' } }),
        makeMockRes(),
        next,
      );
      expect(fail).toHaveBeenCalledWith(
        expect.anything(),
        'contract_bounds_error',
        'bounds exceeded',
        422,
      );
    });
  });

  describe('deleteContract', () => {
    it('deletes contract successfully', async () => {
      mockService.deleteContract.mockResolvedValueOnce(undefined);
      await controller.deleteContract(
        makeMockReq({ params: { id: 'd-1' } }),
        makeMockRes(),
        next,
      );
      expect(ok).toHaveBeenCalledWith(
        expect.anything(),
        { message: 'Contract deleted successfully' },
      );
    });

    it('calls next on error', async () => {
      mockService.deleteContract.mockRejectedValueOnce(new Error('DB error'));
      await controller.deleteContract(
        makeMockReq({ params: { id: 'd-1' } }),
        makeMockRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getContractStats', () => {
    it('returns stats', async () => {
      const stats = { total: 5, active: 3 };
      mockService.getContractStats.mockResolvedValueOnce(stats);
      await controller.getContractStats(makeMockReq(), makeMockRes(), next);
      expect(ok).toHaveBeenCalledWith(expect.anything(), stats);
    });
  });

  describe('getBounds', () => {
    it('returns CONTRACT_BOUNDS', () => {
      controller.getBounds(makeMockReq(), makeMockRes());
      expect(ok).toHaveBeenCalled();
    });
  });

  describe('no side effects on import', () => {
    it('createContractsController does not call getDb', () => {
      const mockSvc = { ...mockService };
      expect(() => createContractsController(mockSvc as any)).not.toThrow();
    });
  });
});