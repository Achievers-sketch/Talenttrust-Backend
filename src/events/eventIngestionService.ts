import { EventAuditService } from '../repository/eventAuditRepository';
import { ContractEvent } from './types';

export interface EventIngestionConfig {
  enableStrictValidation: boolean;
  enablePayloadIntegrityCheck: boolean;
  maxEventAgeMs: number;
  batchSize: number;
}

export interface EventValidationError {
  field: string;
  message: string;
}

export interface EventValidationResult {
  isValid: boolean;
  errors: EventValidationError[];
}

export interface EventIngestionResult {
  deduplicationKey?: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  reason?: string;
  processedAt: Date;
  code?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTimestampNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export class EventIngestionService {
  constructor(
    private readonly auditService: EventAuditService,
    private readonly config: EventIngestionConfig,
  ) {}

  public async processEvent(
    event: ContractEvent,
    contractType: string,
    correlationId?: string,
  ): Promise<EventIngestionResult> {
    const validation = this.validateEvent(event, contractType);
    if (!validation.isValid) {
      return {
        status: 'rejected',
        reason: `Validation failed: ${validation.errors.map((error) => error.message).join('; ')}`,
        processedAt: new Date(),
      };
    }

    try {
      const response = await this.auditService.processEvent(event, contractType, correlationId);

      if (
        response.status === 'rejected' &&
        this.config.enablePayloadIntegrityCheck &&
        response.reason?.includes('already used')
      ) {
        return {
          deduplicationKey: response.deduplicationKey,
          status: 'rejected',
          reason: 'Payload integrity check failed: event payload does not match previously processed event.',
          processedAt: response.processedAt,
          code: response.code,
        };
      }

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown processing error';
      return {
        status: 'rejected',
        reason: `Processing error: ${message}`,
        processedAt: new Date(),
      };
    }
  }

  public async processBatch(
    events: ContractEvent[],
    contractType: string,
    correlationId?: string,
  ): Promise<EventIngestionResult[]> {
    const batchSize = Math.max(1, this.config.batchSize);
    const results: EventIngestionResult[] = [];

    for (let index = 0; index < events.length; index += batchSize) {
      const batch = events.slice(index, index + batchSize);
      const chunkResults = await Promise.all(
        batch.map((event) => this.processEvent(event, contractType, correlationId)),
      );
      results.push(...chunkResults);
    }

    return results;
  }

  public validateEvent(event: unknown, contractType: string): EventValidationResult {
    const errors: EventValidationError[] = [];

    if (!isRecord(event)) {
      return {
        isValid: false,
        errors: [{ field: 'event', message: 'Event must be a JSON object.' }],
      };
    }

    const { contractId, eventId, sequence, timestamp, payload } = event;

    if (typeof contractId !== 'string' || contractId.trim().length === 0) {
      errors.push({ field: 'contractId', message: 'contractId is required.' });
    }

    if (typeof eventId !== 'string' || eventId.trim().length === 0) {
      errors.push({ field: 'eventId', message: 'eventId is required.' });
    }

    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
      errors.push({ field: 'sequence', message: 'sequence must be a non-negative integer.' });
    }

    const timestampNumber = toTimestampNumber(timestamp);
    if (timestampNumber === null) {
      errors.push({ field: 'timestamp', message: 'timestamp must be a valid epoch number or numeric string.' });
    } else if (Date.now() - timestampNumber > this.config.maxEventAgeMs) {
      errors.push({ field: 'timestamp', message: 'Event too old.' });
    }

    if (!isRecord(payload)) {
      errors.push({ field: 'payload', message: 'payload must be an object.' });
    }

    if (this.config.enableStrictValidation) {
      errors.push(...this.validateContractSpecificPayload(contractType, payload));
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  public async getStatistics(): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    duplicates: number;
  }> {
    return this.auditService.getStatistics();
  }

  public async getContractHistory(contractId: string) {
    return this.auditService.getEventHistory(contractId);
  }

  private validateContractSpecificPayload(
    contractType: string,
    payload: unknown,
  ): EventValidationError[] {
    if (!isRecord(payload)) {
      return [];
    }

    if (contractType === 'talent_contract') {
      const errors: EventValidationError[] = [];
      if (typeof payload.talentId !== 'string' || payload.talentId.trim().length === 0) {
        errors.push({ field: 'payload.talentId', message: 'talentId is required for talent_contract events.' });
      }
      if (typeof payload.action !== 'string' || payload.action.trim().length === 0) {
        errors.push({ field: 'payload.action', message: 'action is required for talent_contract events.' });
      }
      return errors;
    }

    return [];
  }
}
