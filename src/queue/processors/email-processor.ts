/**
 * Email Notification Processor
 *
 * Handles asynchronous email sending for notifications.
 * Validates email addresses and handles delivery failures.
 */

import { EmailNotificationPayload, JobResult } from '../types';
import { createLogger } from '../../logger';

/**
 * Generate a cryptographically-strong unique tracking ID for an outbound email.
 *
 * Uses `crypto.randomUUID()` (RFC 4122 v4) so that IDs are collision-resistant
 * even under rapid successive calls, unlike the previous `Date.now() +
 * Math.random()` approach which could produce duplicates under load.
 *
 * @returns A UUID v4 string prefixed with `email_` for readability in logs.
 */
export function generateEmailId(): string {
  return `email_${crypto.randomUUID()}`;
}

/**
 * Process email notification job
 *
 * @param payload - Email notification data
 * @returns Job result with success status
 * @throws Error if email validation fails
 */
export async function processEmailNotification(
  payload: EmailNotificationPayload,
): Promise<JobResult> {
  const log = createLogger({
    processor: 'email',
    ...(payload.correlationId && { correlationId: payload.correlationId }),
    ...(payload.requestId && { requestId: payload.requestId }),
  });

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(payload.to)) {
    // Do not echo the address at info/error level — it is PII
    log.warn('Email validation failed: invalid address format');
    throw new Error(`Invalid email address: ${payload.to}`);
  }

  // Validate required fields
  if (!payload.subject || !payload.body) {
    log.warn('Email validation failed: missing subject or body');
    throw new Error('Email subject and body are required');
  }

  log.info('Sending email notification', {
    subject: payload.subject,
    templateId: payload.templateId,
    // recipient address is omitted — it is in SENSITIVE_PARAMS
  });

  await simulateEmailSend(payload, log);

  const emailId = generateEmailId();

  log.info('Email notification delivered', { emailId, subject: payload.subject });

  return {
    success: true,
    message: `Email sent to ${payload.to}`,
    data: { emailId },
  };
}

/**
 * Simulate email sending with artificial delay.
 * Replace with actual email service API call in production.
 */
async function simulateEmailSend(
  payload: EmailNotificationPayload,
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      log.debug('Email delivery simulation complete', { subject: payload.subject });
      resolve();
    }, 100);
  });
}
