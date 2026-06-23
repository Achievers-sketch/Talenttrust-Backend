import { KeyEscrowEvent, EmailPayload, WebPayload } from '../types/notification.types';
import { NotificationTransport, ConsoleTransport, NotificationResult } from './notification.transport';
import { NotificationRepository } from '../repositories/notificationRepository';
import { getDb } from '../db/database';

/**
 * @title NotificationService
 * @notice Service responsible for dispatching email and web push notifications.
 * @dev Transport layers are pluggable via `NotificationTransport`. Web notifications
 * are persisted using `NotificationRepository` so they survive restarts. Methods
 * return typed results to allow callers to react to partial failures.
 */
export class NotificationService {
  private emailTransport: NotificationTransport;
  private webTransport: NotificationTransport;
  private repo: NotificationRepository;
  /**
   * @notice Sends an email notification to the specified recipient.
   * @dev In production, this would integrate with an SMTP service (e.g. SendGrid, AWS SES).
   * Note on security: `to` address must be validated/sanitized before passing to the real transport
   * to prevent header injection or SSRF using email providers.
   * Rate limiting should also be implemented per recipient email to prevent email bombing.
   * 
   * @param to The recipient's email address.
   * @param event The Key Escrow event triggering this notification.
   * @param data Optional context data for the email template.
   * @return A boolean indicating whether the email was queued/sent successfully.
   */
  constructor(options?: {
    emailTransport?: NotificationTransport;
    webTransport?: NotificationTransport;
    repo?: NotificationRepository;
  }) {
    this.emailTransport = options?.emailTransport ?? ConsoleTransport;
    this.webTransport = options?.webTransport ?? ConsoleTransport;
    this.repo = options?.repo ?? new NotificationRepository(getDb(process.env['DB_PATH'] ?? ':memory:'));
  }

  private isValidEmail(address: string): boolean {
    if (!address) return false;
    // Basic sanity check + header injection protection (no CR/LF)
    if (/[\r\n]/.test(address)) return false;
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(address);
  }

  /**
   * Sends an email notification to the specified recipient.
   * Returns a structured result instead of a bare boolean.
   */
  public async sendEmail(to: string, event: KeyEscrowEvent, data?: any): Promise<NotificationResult> {
    try {
      if (!this.isValidEmail(to)) {
        throw new Error('Invalid email address');
      }

      const payload: EmailPayload = {
        to,
        subject: `Notification: ${event}`,
        body: `Event ${event} has occurred with data: ${JSON.stringify(data || {})}`,
      };

      if (this.emailTransport.sendEmail) {
        const res = await this.emailTransport.sendEmail(payload);
        if (!res.success) {
          console.error(`[NotificationService:Email] Transport failed for ${to}`, res.message);
        }
        return res;
      }

      // Fallback behaviour
      console.log(`[NotificationService:Email] Sending mail to ${payload.to}`, payload);
      return { success: true };
    } catch (error) {
      console.error(`[NotificationService:Email] Failed to send email for event ${event}`, (error as Error).message);
      return { success: false, message: (error as Error).message };
    }
  }

  /**
   * @notice Sends a web push/in-app notification to the specified user.
   * @dev In production, this would persist to a database or use WebSockets/Firebase Push.
   * Security constraints: The `userId` must be authorized against the active session
   * to prevent IDOR vulnerabilities (one user pushing notifications to another).
   * 
   * @param userId The unique identifier of the target user.
   * @param event The Key Escrow event triggering this notification.
   * @param data Optional context data for the UI payload.
   * @return A boolean indicating whether the notification was dispatched successfully.
   */
  /**
   * Sends a web/in-app notification and persists it so UI consumers can fetch
   * missed notifications after restarts. Returns a structured result.
   */
  public async sendWebNotification(userId: string, event: KeyEscrowEvent, data?: any): Promise<NotificationResult> {
    try {
      if (!userId || /[\r\n]/.test(userId)) {
        throw new Error('Invalid user ID');
      }

      const payload: WebPayload = {
        userId,
        title: `Alert: ${event}`,
        message: `Details: ${JSON.stringify(data || {})}`,
      };

      // Persist so the UI can read past notifications
      try {
        this.repo.saveWebNotification(payload.userId, payload.title, payload.message);
      } catch (err: unknown) {
        console.error('[NotificationService:Web] Failed to persist web notification', (err as Error).message);
      }

      if (this.webTransport.sendWebNotification) {
        const res = await this.webTransport.sendWebNotification(payload);
        if (!res.success) {
          console.error(`[NotificationService:Web] Transport failed for ${userId}`, res.message);
        }
        return res;
      }

      console.log(`[NotificationService:Web] Sending web alert to ${payload.userId}`, payload);
      return { success: true };
    } catch (error) {
      console.error(`[NotificationService:Web] Failed to send web alert for event ${event}`, (error as Error).message);
      return { success: false, message: (error as Error).message };
    }
  }
}

export const notificationService = new NotificationService();
