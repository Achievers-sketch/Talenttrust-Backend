import { EmailPayload, WebPayload } from '../types/notification.types';
import { WebhookService } from './webhook.service';

/**
 * Result returned by transports to indicate success/failure and optional message.
 */
export interface NotificationResult {
  success: boolean;
  message?: string;
}

/**
 * Pluggable transport interface for sending notifications.
 *
 * Implementations may support one or both methods depending on capabilities.
 */
export interface NotificationTransport {
  sendEmail?: (payload: EmailPayload) => Promise<NotificationResult>;
  sendWebNotification?: (payload: WebPayload) => Promise<NotificationResult>;
}

/**
 * Simple console transport used as the default fallback in tests and local dev.
 */
export const ConsoleTransport: NotificationTransport = {
  async sendEmail(payload: EmailPayload) {
    console.log('[ConsoleTransport:Email] Sending', payload.to);
    return { success: true };
  },

  async sendWebNotification(payload: WebPayload) {
    console.log('[ConsoleTransport:Web] Sending', payload.userId);
    return { success: true };
  },
};

/**
 * Webhook transport reuses the WebhookService to sign and retry deliveries.
 * The transport sends the provided payload to the configured `url`.
 */
export class WebhookTransport implements NotificationTransport {
  private webhookService: WebhookService;
  private url: string;
  private secret?: string;

  constructor(webhookService: WebhookService, url: string, secret?: string) {
    this.webhookService = webhookService;
    this.url = url;
    this.secret = secret;
  }

  async sendWebNotification(payload: WebPayload) {
    const id = `${payload.userId}:${Date.now()}`;
    try {
      await this.webhookService.send({
        id,
        url: this.url,
        data: payload,
        retryCount: 0,
        webhookSecret: this.secret,
      });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: (err as Error).message };
    }
  }
}
