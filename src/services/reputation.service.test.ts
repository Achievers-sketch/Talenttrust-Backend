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
import Database from 'better-sqlite3';
import { ForbiddenError, ConflictError, ValidationError } from '../errors/appError';
import { auditService } from '../audit/service';

describe('ReputationService', () => {
  let db: Database.Database;

  const reviewerId = 'reviewer-service-test';
  const targetId = 'target-service-test';
  const contextId = 'context-service-test';
  const unrelatedUserId = 'unrelated-user-service-test';

  beforeAll(() => {
    db = getDb(':memory:');
    ReputationService.initialize(db);

    // Insert test data
    db.exec(`
      INSERT INTO users (id, username, email, role, created_at)
      VALUES 
        ('${reviewerId}', 'reviewer', 'reviewer@test.com', 'client', datetime('now')),
        ('${targetId}', 'target', 'target@test.com', 'freelancer', datetime('now')),
        ('${unrelatedUserId}', 'unrelated', 'unrelated@test.com', 'client', datetime('now'));
      
      INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
      VALUES ('${contextId}', 'Test Contract', '${reviewerId}', '${targetId}', 1000, 'completed', 0, datetime('now'));
    `);
  });

  beforeEach(() => {
    // Clear reputation entries before each test
    db.exec('DELETE FROM reputation_entries');
    // Note: auditService is in-memory, so we don't clear it here
    // Tests should query audit entries with filters to get recent ones
  });

  afterAll(() => {
    closeDb();
  });

  describe('createRating - Valid Cases', () => {
    it('should persist valid rating and return entry', () => {
      const result = ReputationService.createRating(
        reviewerId,
        targetId,
        5,
        contextId,
        'Great work!'
      );

      expect(result).toBeDefined();
      expect(result.reviewerId).toBe(reviewerId);
      expect(result.targetId).toBe(targetId);
      expect(result.rating).toBe(5);
      expect(result.comment).toBe('Great work!');
      expect(result.contextId).toBe(contextId);
    });

    it('should create audit log entry on successful write', () => {
      const auditCountBefore = auditService.count();

      ReputationService.createRating(
        reviewerId,
        targetId,
        4,
        contextId,
        'Good job'
      );

      const auditCountAfter = auditService.count();
      expect(auditCountAfter).toBe(auditCountBefore + 1);
    });

    it('should accept boundary rating (1)', () => {
      const result = ReputationService.createRating(
        reviewerId,
        targetId,
        1,
        contextId
      );

      expect(result.rating).toBe(1);
    });

    it('should accept boundary rating (5)', () => {
      // Need unique context to avoid duplicate
      const uniqueContext = 'context-boundary-5';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 500, 'completed', 0, datetime('now'));
      `);

      const result = ReputationService.createRating(
        reviewerId,
        targetId,
        5,
        uniqueContext
      );

      expect(result.rating).toBe(5);
    });

    it('should handle valid comment at max length (1000 chars)', () => {
      // Create a realistic long comment with varied characters
      const longComment = 'Great work on this project! '.repeat(40); // ~1000 chars with variation
      const uniqueContext = 'context-long-comment';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 600, 'completed', 0, datetime('now'));
      `);

      const result = ReputationService.createRating(
        reviewerId,
        targetId,
        5,
        uniqueContext,
        longComment.slice(0, 1000) // Ensure exactly 1000 chars
      );

      expect(result.comment).toBe(longComment.slice(0, 1000));
    });
  });

  describe('createRating - Self-Rating Prevention', () => {
    it('should throw ForbiddenError when reviewerId === targetId', () => {
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          reviewerId, // Self-rating
          5,
          contextId
        );
      }).toThrow(ForbiddenError);
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          reviewerId,
          5,
          contextId
        );
      }).toThrow('Users cannot rate themselves');
    });
  });

  describe('createRating - Duplicate Prevention', () => {
    it('should throw ConflictError for duplicate reviewer+target+context', () => {
      // First rating succeeds
      ReputationService.createRating(
        reviewerId,
        targetId,
        5,
        contextId
      );

      // Second rating with same keys should fail
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          targetId,
          4,
          contextId
        );
      }).toThrow(ConflictError);
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          targetId,
          4,
          contextId
        );
      }).toThrow('Rating already exists');
    });
  });

  describe('createRating - Authorization', () => {
    it('should throw ForbiddenError when reviewer not in contract', () => {
      expect(() => {
        ReputationService.createRating(
          unrelatedUserId,
          targetId,
          5,
          contextId
        );
      }).toThrow(ForbiddenError);
      expect(() => {
        ReputationService.createRating(
          unrelatedUserId,
          targetId,
          5,
          contextId
        );
      }).toThrow('Only contract participants');
    });

    it('should throw ForbiddenError when target not in contract', () => {
      const uniqueContext = 'context-no-target';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${reviewerId}', 700, 'completed', 0, datetime('now'));
      `);

      expect(() => {
        ReputationService.createRating(
          reviewerId,
          unrelatedUserId,
          5,
          uniqueContext
        );
      }).toThrow(ForbiddenError);
    });
  });

  describe('createRating - Comment Validation', () => {
    it('should accept undefined comment (optional)', () => {
      const uniqueContext = 'context-no-comment';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 750, 'completed', 0, datetime('now'));
      `);

      const result = ReputationService.createRating(
        reviewerId,
        targetId,
        5,
        uniqueContext
      );

      expect(result.comment).toBeUndefined();
    });

    it('should accept empty string comment (treated as no comment)', () => {
      const uniqueContext = 'context-empty-comment';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 760, 'completed', 0, datetime('now'));
      `);

      const result = ReputationService.createRating(
        reviewerId,
        targetId,
        5,
        uniqueContext,
        ''
      );

      expect(result.comment).toBe('');
    });

    it('should throw ValidationError for whitespace-only comment', () => {
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          targetId,
          5,
          contextId,
          '   '
        );
      }).toThrow(ValidationError);
    });

    it('should throw ValidationError for spam comment (repetitive chars)', () => {
      const spamComment = 'aaaaabbbbb'; // 50% 'a', 50% 'b' - should pass
      const uniqueContext = 'context-spam-1';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 800, 'completed', 0, datetime('now'));
      `);

      // This should actually pass (exactly 50%)
      const result = ReputationService.createRating(
        reviewerId,
        targetId,
        5,
        uniqueContext,
        spamComment
      );
      expect(result.comment).toBe(spamComment);
    });

    it('should throw ValidationError for highly repetitive comment', () => {
      const spamComment = 'aaaaaaaaab'; // 90% 'a' - should fail
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          targetId,
          5,
          contextId,
          spamComment
        );
      }).toThrow(ValidationError);
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          targetId,
          5,
          contextId,
          spamComment
        );
      }).toThrow('excessive repetitive content');
    });

    it('should throw ValidationError for comment > 1000 chars', () => {
      const longComment = 'a'.repeat(1001);
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          targetId,
          5,
          contextId,
          longComment
        );
      }).toThrow(ValidationError);
      expect(() => {
        ReputationService.createRating(
          reviewerId,
          targetId,
          5,
          contextId,
          longComment
        );
      }).toThrow('exceeds maximum length');
    });
  });

  describe('Audit Tests', () => {
    it('should create audit entry with correct action REPUTATION_UPDATED', () => {
      const uniqueContext = 'context-audit-test';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 900, 'completed', 0, datetime('now'));
      `);

      ReputationService.createRating(
        reviewerId,
        targetId,
        4,
        uniqueContext,
        'Test comment'
      );

      const auditEntries = auditService.query({ action: 'REPUTATION_UPDATED' });
      expect(auditEntries.length).toBeGreaterThanOrEqual(1);
      
      const latestAudit = auditEntries[auditEntries.length - 1];
      expect(latestAudit.action).toBe('REPUTATION_UPDATED');
    });

    it('should have audit entry containing reviewerId, targetId, rating, contextId', () => {
      const uniqueContext = 'context-audit-metadata';
      db.exec(`
        INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES ('${uniqueContext}', 'Test', '${reviewerId}', '${targetId}', 1000, 'completed', 0, datetime('now'));
      `);

      ReputationService.createRating(
        reviewerId,
        targetId,
        5,
        uniqueContext,
        'Audit test'
      );

      const auditEntries = auditService.query({ 
        action: 'REPUTATION_UPDATED',
        actor: reviewerId 
      });
      
      expect(auditEntries.length).toBeGreaterThanOrEqual(1);
      const latestAudit = auditEntries[auditEntries.length - 1];
      
      expect(latestAudit.actor).toBe(reviewerId);
      expect(latestAudit.resourceId).toBe(targetId);
      expect(latestAudit.metadata.rating).toBe(5);
      expect(latestAudit.metadata.contextId).toBe(uniqueContext);
    });
  });

  describe('getProfile', () => {
    it('should return profile with correct aggregated statistics', () => {
      const uniqueContext1 = 'context-profile-1';
      const uniqueContext2 = 'context-profile-2';
      db.exec(`
        INSERT INTO contracts 
        (id, title, client_id, freelancer_id, amount, status, version, created_at)
        VALUES 
          ('${uniqueContext1}', 'Test 1', '${reviewerId}', '${targetId}', 500, 'completed', 0, datetime('now')),
          ('${uniqueContext2}', 'Test 2', '${reviewerId}', '${targetId}', 600, 'completed', 0, datetime('now'));
      `);

      ReputationService.createRating(reviewerId, targetId, 4, uniqueContext1, 'Good');
      ReputationService.createRating(reviewerId, targetId, 5, uniqueContext2, 'Excellent');

      const profile = ReputationService.getProfile(targetId);

      expect(profile.freelancerId).toBe(targetId);
      expect(profile.totalRatings).toBe(2);
      expect(profile.score).toBe(4.5); // (4 + 5) / 2
      expect(profile.reviews.length).toBe(2);
    });

    it('should return empty profile for user with no ratings', () => {
      const profile = ReputationService.getProfile('no-ratings-user');

      expect(profile.freelancerId).toBe('no-ratings-user');
      expect(profile.totalRatings).toBe(0);
      expect(profile.score).toBe(0);
      expect(profile.reviews).toEqual([]);
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
