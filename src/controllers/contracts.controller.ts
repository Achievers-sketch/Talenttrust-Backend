import { Request, Response, NextFunction } from 'express';
import { ContractsService } from '../services/contracts.service';
import { ContractRepository } from '../repositories/contractRepository';
import { getDb } from '../db/database';
import { CreateContractDto, UpdateContractDto } from '../modules/contracts/dto/contract.dto';
import { CONTRACT_BOUNDS, ContractBoundsError } from '../contracts/bounds';
import { NotFoundError } from '../errors/appError';
import { parsePaginationQuery, applyPagination } from '../utils/pagination';
import { ok, fail } from '../utils/apiResponse';

const contractsService = new ContractsService(new ContractRepository(getDb()));

interface ContractIdParams {
  id: string;
}

/**
 * Presentation layer for Contracts.
 * Handles HTTP requests, extracts parameters, and formulates responses.
 * Delegates core logic to the ContractsService.
 */
export class ContractsController {

  /**
   * GET /api/v1/contracts
   * Fetch a paginated list of escrow contracts.
   */
  public static async getContracts(req: Request, res: Response, next: NextFunction) {
    try {
      const pagination = parsePaginationQuery((req.query ?? {}) as Record<string, unknown>);
      if (!pagination.ok) {
        fail(res, 'bad_request', pagination.error, 400);
        return;
      }

      const allContracts = await contractsService.getAllContracts();
      const { page, limit, offset } = pagination.value;
      const pageItems = applyPagination(allContracts, { page, limit, offset });
      const total = allContracts.length;

      ok(res, pageItems, {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/contracts/:id
   * Fetch a single contract by ID (includes version field).
   */
  public static async getContractById(req: Request, res: Response, next: NextFunction) {
    try {
      const contract = await contractsService.getContractById(req.params.id!);
      if (!contract) {
        throw new NotFoundError('The requested resource was not found');
      }
      ok(res, contract);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/contracts
   * Create a new contract
   */
  public static async createContract(req: Request, res: Response, next: NextFunction) {
    try {
      const data: CreateContractDto = req.body;
      const newContract = await contractsService.createContract(data);
      ok(res, newContract, undefined, 201);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  /**
   * PATCH /api/v1/contracts/:id
   * Update an existing contract
   */
  public static async updateContract(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params as unknown as ContractIdParams;
      const updateData: UpdateContractDto = req.body;
      const updatedContract = await contractsService.updateContract(id, updateData);
      ok(res, updatedContract);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  /**
   * DELETE /api/v1/contracts/:id
   * Delete a contract
   */
  public static async deleteContract(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params as unknown as ContractIdParams;
      await contractsService.deleteContract(id);
      ok(res, { message: 'Contract deleted successfully' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/contracts/stats
   * Get contract statistics
   */
  public static async getContractStats(req: Request, res: Response, next: NextFunction) {
    try {
      const stats = await contractsService.getContractStats();
      ok(res, stats);
    } catch (error) {
      if (error instanceof ContractBoundsError) {
        fail(res, 'contract_bounds_error', error.message, 422);
        return;
      }
      next(error);
    }
  }

  /**
   * GET /api/v1/contracts/bounds
   * Returns the enforced per-contract limits for client discovery.
   */
  public static getBounds(_req: Request, res: Response) {
    ok(res, CONTRACT_BOUNDS);
  }
}