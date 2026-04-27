/**
 * Queue Module Entry Point
 * 
 * Exports the main queue functionality for use throughout the application.
 */

export { QueueManager } from './queue-manager';
export {
	JobType,
	JobPayload,
	JobResult,
	JobEnqueueOptions,
	FailedJobEntry,
	FailedJobQuery,
	ReplayJobResult,
	AddJobOptions,
	AddJobResult,
} from './types';
export { queueConfig, getRedisConfig } from './config';
