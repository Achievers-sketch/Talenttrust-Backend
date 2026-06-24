import * as Database from '../db/betterSqlite3';
import { randomUUID } from 'crypto';

interface NotificationRow {
  id: string;
  user_id: string;
  title: string;
  message: string;
  created_at: string;
}

export class NotificationRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  saveWebNotification(userId: string, title: string, message: string): string {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare<[string, string, string, string]>(
        `INSERT INTO notifications (id, user_id, title, message, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, userId, title, message, createdAt);

    return id;
  }

  findByUser(userId: string): Array<{ id: string; title: string; message: string; createdAt: string }> {
    const rows = this.db
      .prepare<[string], NotificationRow>("SELECT id, title, message, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId);

    return rows.map((r) => ({ id: r.id, title: r.title, message: r.message, createdAt: r.created_at }));
  }
}
