import Joi from 'joi';
import { ContractEvent, ValidationResult, EventValidationError } from '../events/types';

export class EventValidator {
  private static eventSchema = Joi.object({
    contractId: Joi.string().required().min(1).max(255),
    eventId: Joi.string().required().min(1).max(255),
    sequence: Joi.number().required().integer().min(0),
    timestamp: Joi.number().required().integer().min(0),
    payload: Joi.object().required(),
    signature: Joi.string().optional()
  });

  static validate(event: ContractEvent): ValidationResult {
    const { error } = this.eventSchema.validate(event, { abortEarly: false });
    
    if (!error) {
      return { isValid: true, errors: [] };
    }

    const errors: EventValidationError[] = error.details.map(detail => ({
      field: detail.path.join('.'),
      message: detail.message,
      value: detail.context?.value
    }));

    return { isValid: false, errors };
  }

  static validatePayload(payload: Record<string, any>, schema: Joi.ObjectSchema): ValidationResult {
    const { error } = schema.validate(payload, { abortEarly: false });
    
    if (!error) {
      return { isValid: true, errors: [] };
    }

    const errors: EventValidationError[] = error.details.map(detail => ({
      field: `payload.${detail.path.join('.')}`,
      message: detail.message,
      value: detail.context?.value
    }));

    return { isValid: false, errors };
  }

  static validateContractSpecificEvent(event: ContractEvent, contractType: string): ValidationResult {
    const baseValidation = this.validate(event);
    if (!baseValidation.isValid) {
      return baseValidation;
    }

    let payloadSchema: Joi.ObjectSchema;

    switch (contractType) {
      case 'talent_contract':
        payloadSchema = Joi.object({
          talentId: Joi.string().required(),
          action: Joi.string().required().valid('created', 'updated', 'verified', 'terminated'),
          metadata: Joi.object().optional()
        });
        break;
      
      case 'payment_contract':
        payloadSchema = Joi.object({
          paymentId: Joi.string().required(),
          amount: Joi.number().required().min(0),
          currency: Joi.string().required(),
          status: Joi.string().required().valid('pending', 'completed', 'failed'),
          timestamp: Joi.number().required()
        });
        break;
      
      case 'review_contract':
        payloadSchema = Joi.object({
          reviewId: Joi.string().required(),
          reviewerId: Joi.string().required(),
          rating: Joi.number().required().integer().min(1).max(5),
          comment: Joi.string().optional(),
          createdAt: Joi.number().required()
        });
        break;
      
      default:
        return {
          isValid: false,
          errors: [{
            field: 'contractId',
            message: `Unknown contract type: ${contractType}`,
            value: contractType
          }]
        };
    }

    return this.validatePayload(event.payload, payloadSchema);
  }
}
