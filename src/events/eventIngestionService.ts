import { ContractEvent, EventIngestionResult, ValidationResult } from './types';
import { EventValidator } from '../validation/eventValidator';
import { EventAuditService } from '../repository/eventAuditRepository';
import { DeduplicationManager } from '../utils/deduplication';

export interface EventIngestionConfig {
  enableStrictValidation: boolean;
  enablePayloadIntegrityCheck: boolean;
  maxEventAgeMs: number;
  batchSize: number;
}

export class EventIngestionService {
  constructor(
    private auditService: EventAuditService,
    private config: EventIngestionConfig
  ) {}

  /**
   * Processes a single contract event with full idempotency guarantees
   * @param event The contract event to process
   * @param contractType The type of contract for schema validation
   * @returns Promise resolving to the ingestion result
   */
  async processEvent(event: ContractEvent, contractType: string): Promise<EventIngestionResult> {
    try {
      // 1. Validate event structure
      const baseValidation = EventValidator.validate(event);
      if (!baseValidation.isValid) {
        const reason = `Validation failed: ${baseValidation.errors.map(e => `${e.field}: ${e.message}`).join(', ')}`;
        return this.auditService.rejectEvent(event, reason);
      }

      // 2. Validate event age
      if (this.config.maxEventAgeMs > 0) {
        const eventAge = Date.now() - event.timestamp;
        if (eventAge > this.config.maxEventAgeMs) {
          return this.auditService.rejectEvent(event, `Event too old: ${eventAge}ms > ${this.config.maxEventAgeMs}ms`);
        }
      }

      // 3. Contract-specific validation if enabled
      if (this.config.enableStrictValidation) {
        const contractValidation = EventValidator.validateContractSpecificEvent(event, contractType);
        if (!contractValidation.isValid) {
          const reason = `Contract validation failed: ${contractValidation.errors.map(e => `${e.field}: ${e.message}`).join(', ')}`;
          return this.auditService.rejectEvent(event, reason);
        }
      }

      // 4. Check for duplicates (idempotency check)
      const deduplicationKey = DeduplicationManager.computeDeduplicationKey(event);
      const existingEvent = await this.auditService.repository.findByDeduplicationKey(deduplicationKey);
      
      if (existingEvent) {
        // Verify payload integrity if enabled
        if (this.config.enablePayloadIntegrityCheck) {
          const payloadIntegrityValid = DeduplicationManager.validatePayloadIntegrity(
            event, 
            existingEvent.payloadHash
          );
          
          if (!payloadIntegrityValid) {
            return this.auditService.rejectEvent(event, 'Payload integrity check failed - possible tampering');
          }
        }

        return {
          deduplicationKey,
          status: 'duplicate',
          reason: 'Event already processed',
          processedAt: new Date()
        };
      }

      // 5. Process the event (accept it)
      return this.auditService.processEvent(event, contractType);

    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error during event processing';
      return this.auditService.rejectEvent(event, `Processing error: ${reason}`);
    }
  }

  /**
   * Processes multiple events in a batch with idempotency guarantees
   * @param events Array of contract events to process
   * @param contractType The type of contract for schema validation
   * @returns Promise resolving to array of ingestion results
   */
  async processBatch(events: ContractEvent[], contractType: string): Promise<EventIngestionResult[]> {
    const results: EventIngestionResult[] = [];
    const batchSize = this.config.batchSize;

    // Process events in batches to avoid overwhelming the system
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      
      // Process batch in parallel for better performance
      const batchPromises = batch.map(event => this.processEvent(event, contractType));
      const batchResults = await Promise.all(batchPromises);
      
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Validates an event without processing it (dry run)
   * @param event The contract event to validate
   * @param contractType The type of contract for schema validation
   * @returns Validation result
   */
  validateEvent(event: ContractEvent, contractType: string): ValidationResult {
    // Base validation
    const baseValidation = EventValidator.validate(event);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    // Event age validation
    if (this.config.maxEventAgeMs > 0) {
      const eventAge = Date.now() - event.timestamp;
      if (eventAge > this.config.maxEventAgeMs) {
        return {
          isValid: false,
          errors: [{
            field: 'timestamp',
            message: `Event too old: ${eventAge}ms > ${this.config.maxEventAgeMs}ms`,
            value: event.timestamp
          }]
        };
      }
    }

    // Contract-specific validation if enabled
    if (this.config.enableStrictValidation) {
      return EventValidator.validateContractSpecificEvent(event, contractType);
    }

    return { isValid: true, errors: [] };
  }

  /**
   * Gets processing statistics for monitoring
   * @returns Processing statistics
   */
  async getStatistics(): Promise<{
    total: number;
    accepted: number;
    rejected: number;
    duplicates: number;
  }> {
    return this.auditService.getStatistics();
  }

  /**
   * Gets event history for a specific contract
   * @param contractId The contract ID to get history for
   * @returns Array of processed events
   */
  async getContractHistory(contractId: string): Promise<any[]> {
    return this.auditService.getEventHistory(contractId);
  }
}
