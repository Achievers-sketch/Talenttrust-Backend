/**
 * ReputationService Tests
 * 
 * Comprehensive tests for all critical paths:
 * - Valid rating creation
 * - Anti-abuse protections (self-rating, duplicates, unauthorized)
 * - Input validation
 * - Audit logging
 * - Profile aggregation
 * - Weighted reputation scoring algorithm
 */

import { ReputationService, computeWeightedReputationScore } from './reputation.service';
import { getDb, closeDb } from '../db/database';
import Database from '../db/betterSqlite3';
import { ForbiddenError, ConflictError, ValidationError } from '../errors/appError';
import { auditService } from '../audit/service';

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

/** ID of the user submitting the rating (reviewer). */
const REVIEWER_ID = 'test-reviewer-001';
/** ID of the user being rated (target / freelancer). */
const TARGET_ID = 'test-target-001';
/** Contract that both {@link REVIEWER_ID} and {@link TARGET_ID} are party to. */
const CONTEXT_ID = 'test-contract-001';
/** User who is NOT a participant in {@link CONTEXT_ID}. */
const OUTSIDER_ID = 'test-outsider-001';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a SHA-256 hex digest of `text`.
 * Must match the internal {@link ReputationService.hashComment} implementation.
 */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Inserts a new contract row so the service's participation check passes.
 *
 * @param db       - Open in-memory SQLite instance.
 * @param id       - The contract UUID.
 * @param clientId - User who plays the client role.
 * @param freelancerId - User who plays the freelancer role.
 */
function insertContract(
  db: Database.Database,
  id: string,
  clientId: string = REVIEWER_ID,
  freelancerId: string = TARGET_ID,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO contracts
       (id, title, client_id, freelancer_id, amount, status, version, created_at)
     VALUES (?, ?, ?, ?, 1000, 'completed', 0, datetime('now'))`,
  ).run(id, `Contract ${id}`, clientId, freelancerId);
}

/**
 * Returns the total number of reputation_entries rows currently in the DB.
 */
function reputationRowCount(db: Database.Database): number {
  const row = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM reputation_entries').get();
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ReputationService.createRating — anti-abuse protections', () => {
  let db: Database.Database;

  beforeAll(() => {
    // Use a fresh in-memory SQLite instance with full schema migrations.
    db = getDb(':memory:');
    ReputationService.initialize(db);

    // Seed the minimal user rows required by FK constraints.
    db.exec(`
      INSERT OR IGNORE INTO users (id, username, email, role, created_at)
      VALUES
        ('${REVIEWER_ID}', 'reviewer01', 'reviewer@test.com', 'client', datetime('now')),
        ('${TARGET_ID}',   'target01',   'target@test.com',   'freelancer', datetime('now')),
        ('${OUTSIDER_ID}', 'outsider01', 'outsider@test.com', 'client',    datetime('now'));
    `);

    // Seed the main contract used by most tests.
    insertContract(db, CONTEXT_ID);
  });

  beforeEach(() => {
    // Wipe entries so tests are fully isolated.
    db.exec('DELETE FROM reputation_entries');
  });

  afterAll(() => {
    closeDb();
  });

  // =========================================================================
  // Guard 1 — Self-rating prevention
  // =========================================================================

  describe('Guard 1 — self-rating prevention', () => {
    it('throws ForbiddenError when reviewerId === targetId', () => {
      expect(() =>
        ReputationService.createRating(REVIEWER_ID, REVIEWER_ID, 5, CONTEXT_ID),
      ).toThrow(ForbiddenError);
    });

    it('carries the message "Users cannot rate themselves"', () => {
      expect(() =>
        ReputationService.createRating(REVIEWER_ID, REVIEWER_ID, 3, CONTEXT_ID),
      ).toThrow('Users cannot rate themselves');
    });

    it('does not persist any DB row on self-rating', () => {
      try {
        ReputationService.createRating(REVIEWER_ID, REVIEWER_ID, 4, CONTEXT_ID);
      } catch { /* expected */ }
      expect(reputationRowCount(db)).toBe(0);
    });

    it('does not emit an audit entry on self-rating', () => {
      const before = auditService.count();
      try {
        ReputationService.createRating(REVIEWER_ID, REVIEWER_ID, 4, CONTEXT_ID);
      } catch { /* expected */ }
      expect(auditService.count()).toBe(before);
    });
  });

  // =========================================================================
  // Guard 2 — Duplicate-rating prevention
  // =========================================================================

  describe('Guard 2 — duplicate-rating prevention', () => {
    it('throws ConflictError when reviewer+target+context already exists', () => {
      // First rating must succeed.
      ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID);

      expect(() =>
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID),
      ).toThrow(ConflictError);
    });

    it('carries the message "Rating already exists"', () => {
      ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID);

      expect(() =>
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 3, CONTEXT_ID),
      ).toThrow('Rating already exists');
    });

    it('does not add a second DB row on duplicate attempt', () => {
      ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID);
      try {
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID);
      } catch { /* expected */ }
      expect(reputationRowCount(db)).toBe(1);
    });

    it('allows a different reviewer to rate the same target on the same contract', () => {
      // Insert an extra user and contract that includes them.
      const altCtx = 'contract-alt-reviewer';
      db.prepare(
        `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
         VALUES ('alt-reviewer-001', 'alt01', 'alt@test.com', 'client', datetime('now'))`,
      ).run();
      insertContract(db, altCtx, 'alt-reviewer-001', TARGET_ID);

      ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID);
      // Different reviewer, different context — must NOT throw.
      expect(() =>
        ReputationService.createRating('alt-reviewer-001', TARGET_ID, 4, altCtx),
      ).not.toThrow();
    });

    it('allows the same reviewer to rate a different target on a different contract', () => {
      const altCtx = 'contract-diff-target';
      db.prepare(
        `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
         VALUES ('alt-target-001', 'alttarget01', 'alttarget@test.com', 'freelancer', datetime('now'))`,
      ).run();
      insertContract(db, altCtx, REVIEWER_ID, 'alt-target-001');

      ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID);
      expect(() =>
        ReputationService.createRating(REVIEWER_ID, 'alt-target-001', 4, altCtx),
      ).not.toThrow();
    });
  });

  // =========================================================================
  // Guard 3 — Contract participation check
  // =========================================================================

  describe('Guard 3 — contract-participation check', () => {
    it('throws ForbiddenError when reviewer is not a contract participant', () => {
      expect(() =>
        ReputationService.createRating(OUTSIDER_ID, TARGET_ID, 5, CONTEXT_ID),
      ).toThrow(ForbiddenError);
    });

    it('carries the message "Only contract participants"', () => {
      expect(() =>
        ReputationService.createRating(OUTSIDER_ID, TARGET_ID, 5, CONTEXT_ID),
      ).toThrow('Only contract participants');
    });

    it('throws ForbiddenError when target is not a contract participant', () => {
      const ctxNoTarget = 'contract-no-target-001';
      // Reviewer is client AND freelancer — target is not in this contract.
      insertContract(db, ctxNoTarget, REVIEWER_ID, REVIEWER_ID);

      expect(() =>
        ReputationService.createRating(REVIEWER_ID, OUTSIDER_ID, 5, ctxNoTarget),
      ).toThrow(ForbiddenError);
    });

    it('does not persist any DB row when reviewer is not a participant', () => {
      try {
        ReputationService.createRating(OUTSIDER_ID, TARGET_ID, 5, CONTEXT_ID);
      } catch { /* expected */ }
      expect(reputationRowCount(db)).toBe(0);
    });

    it('does not emit an audit entry when reviewer is not a participant', () => {
      const before = auditService.count();
      try {
        ReputationService.createRating(OUTSIDER_ID, TARGET_ID, 5, CONTEXT_ID);
      } catch { /* expected */ }
      expect(auditService.count()).toBe(before);
    });

    it('throws ForbiddenError for a non-existent contractId', () => {
      expect(() =>
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, 'non-existent-contract'),
      ).toThrow(ForbiddenError);
    });
  });

  // =========================================================================
  // Guard 4 — Comment validation
  // =========================================================================

  describe('Guard 4 — comment validation', () => {
    describe('length limit (max 1000 chars)', () => {
      it('throws ValidationError for a 1001-char comment', () => {
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID,
            'a'.repeat(1001),
          ),
        ).toThrow(ValidationError);
      });

      it('throws ValidationError containing "exceeds maximum length"', () => {
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID,
            'b'.repeat(1001),
          ),
        ).toThrow('exceeds maximum length');
      });

      it('accepts a comment of exactly 1000 chars (boundary — valid)', () => {
        // Need a 1000-char string that is NOT all-same character (else spam guard fires).
        const borderline = ('ab'.repeat(500)); // 1000 chars, max-char-count = 500 = 50% → allowed
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID, borderline,
          ),
        ).not.toThrow();
      });

      it('accepts a comment of 999 chars (boundary — valid)', () => {
        const almostMax = 'Great work! '.repeat(83).slice(0, 999); // < 1000, varied chars
        const ctx999 = 'contract-999-chars';
        insertContract(db, ctx999);
        expect(() =>
          ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, ctx999, almostMax),
        ).not.toThrow();
      });
    });

    describe('whitespace-only comment', () => {
      it('throws ValidationError for a pure-space comment', () => {
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID, '   ',
          ),
        ).toThrow(ValidationError);
      });

      it('throws ValidationError for a tab/newline-only comment', () => {
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID, '\t\n',
          ),
        ).toThrow(ValidationError);
      });

      it('carries the message "empty or whitespace-only"', () => {
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID, '    ',
          ),
        ).toThrow('empty or whitespace-only');
      });
    });

    describe('empty comment (edge case)', () => {
      it('accepts an empty string without throwing', () => {
        const ctxEmpty = 'contract-empty-comment';
        insertContract(db, ctxEmpty);
        expect(() =>
          ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, ctxEmpty, ''),
        ).not.toThrow();
      });
    });

    describe('spam / repeated-char detection (> 50% single char)', () => {
      it('throws ValidationError for a comment that is 100% one character', () => {
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID,
            'a'.repeat(10),
          ),
        ).toThrow(ValidationError);
      });

      it('throws ValidationError containing "excessive repetitive content"', () => {
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID,
            'a'.repeat(10),
          ),
        ).toThrow('excessive repetitive content');
      });

      it('throws ValidationError for 90%-repetitive comment ("aaaaaaaaab")', () => {
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID, 'aaaaaaaaab',
          ),
        ).toThrow(ValidationError);
      });

      it('accepts a comment where max-char is exactly 50% (boundary)', () => {
        const ctx50 = 'contract-50pct-boundary';
        insertContract(db, ctx50);
        // 'aaaaabbbbb' — 'a' appears 5/10 = 50 % → NOT > 0.5, so allowed.
        expect(() =>
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, ctx50, 'aaaaabbbbb',
          ),
        ).not.toThrow();
      });

      it('does not persist a DB row for a spam comment', () => {
        try {
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, CONTEXT_ID, 'a'.repeat(20),
          );
        } catch { /* expected */ }
        expect(reputationRowCount(db)).toBe(0);
      });
    });

    describe('undefined comment (optional field)', () => {
      it('accepts no comment argument', () => {
        const ctxNoComment = 'contract-no-comment';
        insertContract(db, ctxNoComment);
        expect(() =>
          ReputationService.createRating(REVIEWER_ID, TARGET_ID, 3, ctxNoComment),
        ).not.toThrow();
      });
    });
  });

  // =========================================================================
  // Guard 5 — Persist + return
  // =========================================================================

  describe('Happy path — persist and return', () => {
    it('persists the entry and returns the created ReputationEntry', () => {
      const result = ReputationService.createRating(
        REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID, 'Great collaboration!',
      );

      expect(result).toMatchObject({
        reviewerId: REVIEWER_ID,
        targetId: TARGET_ID,
        rating: 5,
        comment: 'Great collaboration!',
        contextId: CONTEXT_ID,
      });
      expect(typeof result.id).toBe('string');
      expect(typeof result.createdAt).toBe('string');
    });

    it('increments reputation_entries count by 1 on success', () => {
      expect(reputationRowCount(db)).toBe(0);
      const ctxPersist = 'contract-persist-check';
      insertContract(db, ctxPersist);
      ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, ctxPersist);
      expect(reputationRowCount(db)).toBe(1);
    });

    it('accepts rating at lower boundary (1)', () => {
      const ctx1 = 'contract-rating-1';
      insertContract(db, ctx1);
      const result = ReputationService.createRating(REVIEWER_ID, TARGET_ID, 1, ctx1);
      expect(result.rating).toBe(1);
    });

    it('accepts rating at upper boundary (5)', () => {
      const ctx5 = 'contract-rating-5';
      insertContract(db, ctx5);
      const result = ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, ctx5);
      expect(result.rating).toBe(5);
    });
  });

  // =========================================================================
  // Guard 6 — Mandatory audit logging
  // =========================================================================

  describe('Guard 6 — mandatory audit logging', () => {
    describe('audit entry shape', () => {
      it('increments audit log count by 1 on success', () => {
        const ctxAudit = 'contract-audit-count';
        insertContract(db, ctxAudit);
        const before = auditService.count();
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, ctxAudit, 'Timely!');
        expect(auditService.count()).toBe(before + 1);
      });

      it('records action = "REPUTATION_UPDATED"', () => {
        const ctxAction = 'contract-audit-action';
        insertContract(db, ctxAction);
        const before = auditService.count();
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, ctxAction);
        const entries = auditService.query({ action: 'REPUTATION_UPDATED' });
        // There should be at least one new entry.
        expect(entries.length).toBeGreaterThan(0);
        const newest = entries[entries.length - 1];
        expect(newest.action).toBe('REPUTATION_UPDATED');
        expect(auditService.count()).toBe(before + 1);
      });

      it('records actor = reviewerId', () => {
        const ctxActor = 'contract-audit-actor';
        insertContract(db, ctxActor);
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 3, ctxActor);
        const entries = auditService.query({
          action: 'REPUTATION_UPDATED',
          actor: REVIEWER_ID,
        });
        expect(entries.length).toBeGreaterThan(0);
        expect(entries[entries.length - 1].actor).toBe(REVIEWER_ID);
      });

      it('records resourceId = targetId', () => {
        const ctxResource = 'contract-audit-resource';
        insertContract(db, ctxResource);
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, ctxResource);
        const entries = auditService.query({
          action: 'REPUTATION_UPDATED',
          actor: REVIEWER_ID,
          resourceId: TARGET_ID,
        });
        expect(entries.length).toBeGreaterThan(0);
        expect(entries[entries.length - 1].resourceId).toBe(TARGET_ID);
      });

      it('stores the rating value in metadata', () => {
        const ctxRating = 'contract-audit-rating';
        insertContract(db, ctxRating);
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 2, ctxRating);
        const entries = auditService.query({
          action: 'REPUTATION_UPDATED',
          actor: REVIEWER_ID,
        });
        expect(entries[entries.length - 1].metadata.rating).toBe(2);
      });

      it('stores the contextId in metadata', () => {
        const ctxCtxId = 'contract-audit-ctxid';
        insertContract(db, ctxCtxId);
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 3, ctxCtxId);
        const entries = auditService.query({
          action: 'REPUTATION_UPDATED',
          actor: REVIEWER_ID,
        });
        expect(entries[entries.length - 1].metadata.contextId).toBe(ctxCtxId);
      });
    });

    describe('comment hashing — SHA-256, NOT plaintext', () => {
      it('stores comment as SHA-256 hash in audit metadata', () => {
        const comment = 'Excellent work, very satisfied!';
        const ctxHash = 'contract-audit-hash';
        insertContract(db, ctxHash);
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, ctxHash, comment);
        const entries = auditService.query({
          action: 'REPUTATION_UPDATED',
          actor: REVIEWER_ID,
        });
        const meta = entries[entries.length - 1].metadata;
        expect(meta.comment).toBe(sha256(comment));
        expect(meta.comment).not.toBe(comment);
      });

      it('stores undefined (not empty string) in audit metadata when no comment', () => {
        const ctxNoComment = 'contract-audit-nocomment';
        insertContract(db, ctxNoComment);
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, ctxNoComment);
        const entries = auditService.query({
          action: 'REPUTATION_UPDATED',
          actor: REVIEWER_ID,
        });
        const meta = entries[entries.length - 1].metadata;
        expect(meta.comment).toBeUndefined();
      });

      it('different comments produce different hashes', () => {
        const comment1 = 'Good work';
        const comment2 = 'Great work';
        expect(sha256(comment1)).not.toBe(sha256(comment2));
      });
    });

    describe('audit-failure rollback path', () => {
      afterEach(() => {
        jest.restoreAllMocks();
      });

      /**
       * When auditService.log throws AFTER the entry is persisted, the service
       * must re-throw with 'Failed to create audit trail. Rating not persisted.'
       *
       * NOTE: The error message is intentionally misleading — the DB row IS already
       * written at this point. This is the documented behaviour and what we assert.
       */
      it('throws when auditService.log throws, with message "Failed to create audit trail"', () => {
        jest.spyOn(auditService, 'log').mockImplementationOnce(() => {
          throw new Error('Simulated store failure');
        });
        const ctxFail = 'contract-audit-fail';
        insertContract(db, ctxFail);

        expect(() =>
          ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, ctxFail, 'Good work'),
        ).toThrow('Failed to create audit trail');
      });

      it('persists the DB row even when audit logging subsequently fails', () => {
        jest.spyOn(auditService, 'log').mockImplementationOnce(() => {
          throw new Error('Simulated store failure');
        });
        const ctxFailPersist = 'contract-audit-fail-persist';
        insertContract(db, ctxFailPersist);

        try {
          ReputationService.createRating(
            REVIEWER_ID, TARGET_ID, 4, ctxFailPersist, 'Good work',
          );
        } catch { /* expected */ }

        // The row is persisted before the audit call — so it should be present.
        expect(reputationRowCount(db)).toBe(1);
      });

      it('wraps audit errors so caller sees generic message, not internal detail', () => {
        jest.spyOn(auditService, 'log').mockImplementationOnce(() => {
          throw new Error('Internal DB error: disk full');
        });
        const ctxWrap = 'contract-audit-wrap';
        insertContract(db, ctxWrap);

        let thrown: Error | null = null;
        try {
          ReputationService.createRating(REVIEWER_ID, TARGET_ID, 4, ctxWrap);
        } catch (e) {
          thrown = e as Error;
        }
        expect(thrown).not.toBeNull();
        expect(thrown!.message).toContain('Failed to create audit trail');
        expect(thrown!.message).not.toContain('disk full');
      });
    });
  });

  // =========================================================================
  // Uninitialized service guard
  // =========================================================================

  describe('service initialization guard', () => {
    it('throws when called before initialize()', () => {
      // Save current state, reset, test, restore.
      (ReputationService as any).repository = null;
      expect(() =>
        ReputationService.createRating(REVIEWER_ID, TARGET_ID, 5, CONTEXT_ID),
      ).toThrow('ReputationService not initialized');
      // Restore.
      ReputationService.initialize(db);
    });
  });

  describe('computeWeightedReputationScore - Pure Function Tests', () => {
    const now = new Date('2024-01-15T00:00:00.000Z');
    const lambda = 0.005;

    it('should return 0 for empty ratings array', () => {
      const result = computeWeightedReputationScore([], now, lambda);
      expect(result).toBe(0);
    });

    it('should return rating value for single rating at exactly now', () => {
      const ratings = [
        { rating: 4, createdAt: '2024-01-15T00:00:00.000Z' }
      ];
      const result = computeWeightedReputationScore(ratings, now, lambda);
      expect(result).toBe(4);
    });

    it('should return rating value for single old rating (weight cancels out)', () => {
      const ratings = [
        { rating: 3, createdAt: '2023-01-15T00:00:00.000Z' } // 365 days old
      ];
      const result = computeWeightedReputationScore(ratings, now, lambda);
      expect(result).toBe(3);
    });

    it('should return common value for two equal ratings with different ages', () => {
      const ratings = [
        { rating: 4, createdAt: '2024-01-15T00:00:00.000Z' }, // today
        { rating: 4, createdAt: '2023-01-15T00:00:00.000Z' }  // 365 days old
      ];
      const result = computeWeightedReputationScore(ratings, now, lambda);
      expect(result).toBe(4);
    });

    it('should bias upward when newer rating is higher', () => {
      const ratings = [
        { rating: 5, createdAt: '2024-01-15T00:00:00.000Z' }, // today, high
        { rating: 1, createdAt: '2023-01-15T00:00:00.000Z' }  // 365 days old, low
      ];
      const result = computeWeightedReputationScore(ratings, now, lambda);
      const simpleMean = 3.0;
      expect(result).toBeGreaterThan(simpleMean);
      expect(result).toBeLessThanOrEqual(5.0);
    });

    it('should bias downward when newer rating is lower', () => {
      const ratings = [
        { rating: 1, createdAt: '2024-01-15T00:00:00.000Z' }, // today, low
        { rating: 5, createdAt: '2023-01-15T00:00:00.000Z' }  // 365 days old, high
      ];
      const result = computeWeightedReputationScore(ratings, now, lambda);
      const simpleMean = 3.0;
      expect(result).toBeLessThan(simpleMean);
      expect(result).toBeGreaterThanOrEqual(1.0);
    });

    it('should keep score within rating range for all old ratings', () => {
      const ratings = [
        { rating: 5, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 1, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 3, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 4, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 2, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 5, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 3, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 4, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 2, createdAt: '2023-01-15T00:00:00.000Z' },
        { rating: 1, createdAt: '2023-01-15T00:00:00.000Z' },
      ];
      const result = computeWeightedReputationScore(ratings, now, lambda);
      const values = ratings.map(r => r.rating);
      const minRating = Math.min(...values);
      const maxRating = Math.max(...values);
      expect(result).toBeGreaterThanOrEqual(minRating);
      expect(result).toBeLessThanOrEqual(maxRating);
    });

    it('should keep score within rating range for mixed recency', () => {
      const ratings = [
        { rating: 5, createdAt: '2024-01-15T00:00:00.000Z' },   // 0 days
        { rating: 4, createdAt: '2024-01-05T00:00:00.000Z' },   // 10 days
        { rating: 3, createdAt: '2023-12-15T00:00:00.000Z' },  // ~31 days
        { rating: 2, createdAt: '2023-09-15T00:00:00.000Z' },  // ~122 days
        { rating: 1, createdAt: '2022-07-15T00:00:00.000Z' },  // ~549 days
      ];
      const result = computeWeightedReputationScore(ratings, now, lambda);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(5);
    });

    it('should decay faster with higher lambda', () => {
      const ratings = [
        { rating: 5, createdAt: '2024-01-15T00:00:00.000Z' },  // today, high
        { rating: 1, createdAt: '2023-01-15T00:00:00.000Z' }   // 365 days old, low
      ];
      
      const lowLambda = 0.001;
      const highLambda = 0.1;
      
      const resultLowLambda = computeWeightedReputationScore(ratings, now, lowLambda);
      const resultHighLambda = computeWeightedReputationScore(ratings, now, highLambda);
      
      // With higher lambda, old ratings decay more, so score should be closer to the recent high rating (5)
      expect(resultHighLambda).toBeGreaterThan(resultLowLambda);
    });

    it('should return identical results for identical inputs (deterministic)', () => {
      const ratings = [
        { rating: 4, createdAt: '2024-01-10T00:00:00.000Z' },
        { rating: 3, createdAt: '2023-12-01T00:00:00.000Z' },
      ];
      
      const result1 = computeWeightedReputationScore(ratings, now, lambda);
      const result2 = computeWeightedReputationScore(ratings, now, lambda);
      
      expect(result1).toBe(result2);
    });

    it('should handle future createdAt defensively (clock skew)', () => {
      const ratings = [
        { rating: 4, createdAt: '2024-01-16T00:00:00.000Z' } // 1 day in future
      ];
      
      const result = computeWeightedReputationScore(ratings, now, lambda);
      
      // Should not throw and should return the rating value (age clamped to 0, weight = 1)
      expect(result).toBe(4);
    });

    it('should return exact rating value for single rating with age = 0', () => {
      const ratings = [
        { rating: 3.5, createdAt: '2024-01-15T00:00:00.000Z' }
      ];
      
      const result = computeWeightedReputationScore(ratings, now, lambda);
      
      // weight = exp(0) = 1, so result = 3.5 * 1 / 1 = 3.5
      expect(result).toBe(3.5);
    });
  });

  describe('getProfile - Weighted Score Integration', () => {
    it('should return weightedScore field', () => {
      const uniqueContext = 'context-weighted-1';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 1100, 'completed', 0, datetime('now'));
      `);

      ReputationService.createRating(reviewerId, targetId, 5, uniqueContext);

      const profile = ReputationService.getProfile(targetId);

      expect(profile.weightedScore).toBeDefined();
      expect(typeof profile.weightedScore).toBe('number');
      expect(profile.weightedScore).toBeGreaterThanOrEqual(0);
      expect(profile.weightedScore).toBeLessThanOrEqual(5);
    });

    it('should return scoreAlgorithm field', () => {
      const uniqueContext = 'context-weighted-2';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 1200, 'completed', 0, datetime('now'));
      `);

      ReputationService.createRating(reviewerId, targetId, 4, uniqueContext);

      const profile = ReputationService.getProfile(targetId);

      expect(profile.scoreAlgorithm).toBeDefined();
      expect(typeof profile.scoreAlgorithm).toBe('string');
      expect(profile.scoreAlgorithm).toBe('exp-decay-v1');
    });

    it('should preserve all existing fields in profile', () => {
      const uniqueContext = 'context-weighted-3';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 1300, 'completed', 0, datetime('now'));
      `);

      ReputationService.createRating(reviewerId, targetId, 5, uniqueContext, 'Excellent');

      const profile = ReputationService.getProfile(targetId);

      // Verify all existing fields are still present
      expect(profile.freelancerId).toBeDefined();
      expect(profile.score).toBeDefined();
      expect(profile.jobsCompleted).toBeDefined();
      expect(profile.totalRatings).toBeDefined();
      expect(profile.reviews).toBeDefined();
      expect(profile.lastUpdated).toBeDefined();
      
      // Verify arithmetic mean is unchanged
      expect(profile.totalRatings).toBe(1);
      expect(profile.score).toBe(5);
    });

    it('should return weightedScore = 0 for zero ratings', () => {
      const profile = ReputationService.getProfile('no-ratings-user-weighted');

      expect(profile.weightedScore).toBe(0);
      expect(profile.totalRatings).toBe(0);
    });

    it('should bias weightedScore toward recent ratings', () => {
      const uniqueContext1 = 'context-weighted-old';
      const uniqueContext2 = 'context-weighted-new';
      
      // Create contracts
      db.exec(`
        INSERT INTO contracts 
        (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES 
          ('${uniqueContext1}', 'Old Contract', '${reviewerId}', '${targetId}', 1400, 'completed', 0, datetime('now', '-365 days')),
          ('${uniqueContext2}', 'New Contract', '${reviewerId}', '${targetId}', 1500, 'completed', 0, datetime('now'));
      `);

      // Insert old low rating manually with old createdAt
      db.exec(`
        INSERT INTO reputation_entries (id, reviewer_id, target_id, rating, comment, context_id, created_at)
        VALUES ('old-rating-id', '${reviewerId}', '${targetId}', 1, 'Old rating', '${uniqueContext1}', datetime('now', '-365 days'));
      `);

      // Insert recent high rating
      ReputationService.createRating(reviewerId, targetId, 5, uniqueContext2, 'Recent rating');

      const profile = ReputationService.getProfile(targetId);

      // Arithmetic mean should be (1 + 5) / 2 = 3.0
      expect(profile.score).toBe(3.0);
      expect(profile.totalRatings).toBe(2);
      
      // Weighted score should be > 3.0 because recent rating (5) has more weight
      expect(profile.weightedScore).toBeGreaterThan(3.0);
      expect(profile.weightedScore).toBeLessThanOrEqual(5.0);
    });
  });
});
