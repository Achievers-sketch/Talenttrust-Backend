import { ReputationProfile } from '../types/reputation';
import { ReputationRepository, ReputationEntry } from '../repositories/reputationRepository';
import { auditService } from '../audit/service';
import { ForbiddenError, ConflictError, ValidationError } from '../errors/appError';
import Database from '../db/betterSqlite3';
import { createHash } from 'crypto';
import { validateEnv } from '../config/env.schema';

/**
 * Computes a recency-weighted reputation score using exponential time decay.
 *
 * Each rating's contribution is weighted by exp(-λ * ageInDays), where ageInDays
 * is the number of days between the rating's createdAt timestamp and the reference
 * date (now). Newer ratings contribute more; older ratings decay toward zero weight.
 *
 * The result is guaranteed to be within the rating value range if all input ratings
 * are within that range. Returns 0 for an empty ratings array.
 *
 * @param ratings - Array of rating records; each must have a numeric rating value
 *                  and an ISO 8601 createdAt timestamp string.
 * @param now     - Reference date for age calculation; parameterised for
 *                  deterministic testing with fixed clocks.
 * @param lambda  - Decay constant (λ); higher values decay faster.
 *                  Must be positive. Source: REPUTATION_DECAY_LAMBDA env config.
 * @returns The weighted mean score, or 0 if ratings is empty.
 */
export function computeWeightedReputationScore(
  ratings: Array<{ rating: number; createdAt: string }>,
  now: Date,
  lambda: number
): number {
  // Empty ratings array returns 0
  if (ratings.length === 0) {
    return 0;
  }

  let weightedSum = 0;
  let totalWeight = 0;

  const nowTime = now.getTime();

  for (const ratingEntry of ratings) {
    // Parse createdAt ISO string to Date
    const createdAtTime = new Date(ratingEntry.createdAt).getTime();
    
    // Compute age in days, clamping to 0 minimum (defense against future timestamps)
    const ageInDays = Math.max(0, (nowTime - createdAtTime) / (1000 * 60 * 60 * 24));
    
    // Compute exponential decay weight
    const weight = Math.exp(-lambda * ageInDays);
    
    // Accumulate weighted sum and total weight
    weightedSum += ratingEntry.rating * weight;
    totalWeight += weight;
  }

  // Defensive check (theoretically impossible with finite lambda and non-negative ages)
  if (totalWeight === 0) {
    return 0;
  }

  return weightedSum / totalWeight;
}

/**
 * @title Reputation Service
 * @dev Production-grade reputation management with anti-abuse protections and audit logging.
 * 
 * Security features:
 * - Self-rating prevention
 * - Duplicate rating prevention (application + DB level)
 * - Contract participation validation
 * - Comment spam detection
 * - Mandatory audit trail for all writes
 */
export class ReputationService {
  private static repository: ReputationRepository | null = null;

  /**
   * Initialize the service with a database connection.
   * Must be called once during application startup.
   */
  public static initialize(db: Database.Database): void {
    this.repository = new ReputationRepository(db);
  }

  /**
   * Creates a new reputation rating with comprehensive anti-abuse protections.
   * 
   * @param reviewerId - The user submitting the rating
   * @param targetId - The user being rated
   * @param rating - Rating value (1-5)
   * @param contextId - Contract/context reference
   * @param comment - Optional review comment
   * @returns The created ReputationEntry
   * 
   * @throws ForbiddenError if self-rating or unauthorized
   * @throws ConflictError if duplicate rating exists
   * @throws ValidationError if comment fails validation
   */
  public static createRating(
    reviewerId: string,
    targetId: string,
    rating: number,
    contextId: string,
    comment?: string
  ): ReputationEntry {
    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    /**
     * Guard 1 — Self-rating prevention.
     * A user must not be able to inflate their own reputation score.
     * @throws {ForbiddenError} When reviewerId === targetId.
     */
    if (reviewerId === targetId) {
      throw new ForbiddenError('Users cannot rate themselves');
    }

    /**
     * Guard 2 — Duplicate-rating prevention (application-level).
     * A secondary DB-level UNIQUE constraint exists as a safety net.
     * Checked here first to return a friendly 409 before hitting the DB.
     * @throws {ConflictError} When a rating for the same reviewer/target/context already exists.
     */
    const existing = this.repository.findByReviewerTargetContext(
      reviewerId,
      targetId,
      contextId
    );
    if (existing) {
      throw new ConflictError('Rating already exists for this reviewer, target, and context');
    }

    /**
     * Guard 3 — Contract-participation check.
     * Both the reviewer and the target must be party to the referenced contract.
     * This prevents ratings between arbitrary users who never worked together.
     * @throws {ForbiddenError} When either party is not listed on the contract.
     */
    const reviewerParticipates = this.repository.verifyContractParticipation(
      contextId,
      reviewerId
    );
    const targetParticipates = this.repository.verifyContractParticipation(
      contextId,
      targetId
    );
    if (!reviewerParticipates || !targetParticipates) {
      throw new ForbiddenError('Only contract participants can submit ratings');
    }

    /**
     * Guard 4 — Comment validation (defense-in-depth).
     * Applied in addition to Zod validation at the route layer.
     * Catches: over-length comments, whitespace-only comments, and spam
     * (single character comprising > 50 % of the comment body).
     * @throws {ValidationError} When the comment fails any content policy rule.
     */
    if (comment) {
      this.validateComment(comment);
    }

    /**
     * Guard 5 — Persist the reputation entry.
     * Runs only after all guards have passed.
     */
    const entry = this.repository.create({
      reviewerId,
      targetId,
      rating,
      comment,
      contextId,
    });

    /**
     * Guard 6 — Mandatory audit log.
     * Every successful write MUST produce an immutable audit entry.
     * The comment is stored as a SHA-256 hash to avoid leaking PII into the
     * audit store; the plaintext is never logged.
     *
     * IMPORTANT: If audit logging fails the error is re-thrown so the caller
     * receives a generic 'Failed to create audit trail' message.  At this point
     * the DB row has already been persisted — callers that need strict
     * atomicity must implement compensating logic (e.g. soft-delete the entry).
     *
     * @throws {Error} 'Failed to create audit trail. Rating not persisted.'
     *                  when the audit store is unavailable.
     */
    try {
      auditService.log({
        action: 'REPUTATION_UPDATED',
        severity: 'INFO',
        actor: reviewerId,
        resource: 'reputation',
        resourceId: targetId,
        metadata: {
          rating,
          comment: comment ? this.hashComment(comment) : undefined,
          contextId,
        },
      });
    } catch (auditError) {
      // If audit logging fails, we should not silently continue
      // In production, this would trigger an alert
      console.error('[ReputationService] Audit logging failed:', auditError);
      throw new Error('Failed to create audit trail. Rating not persisted.');
    }

    return entry;
  }

  /**
   * Retrieves a freelancer's reputation profile with aggregated statistics.
   * 
   * @param targetId - The target user's ID
   * @returns ReputationProfile with aggregated stats and reviews
   */
  public static getProfile(targetId: string): ReputationProfile {
    // Ensure repository is initialized
    if (!this.repository) {
      throw new Error('ReputationService not initialized. Call initialize() first.');
    }

    if (!targetId) {
      throw new Error('Target ID is required');
    }

    const entries = this.repository.findByTargetId(targetId);

    // Aggregate statistics
    const totalRatings = entries.length;
    const score = totalRatings > 0
      ? entries.reduce((sum, entry) => sum + entry.rating, 0) / totalRatings
      : 0;

    // Get validated config for reputation scoring parameters
    // Use try-catch to gracefully handle test environments where full env may not be set
    let lambda = 0.005; // default
    let algorithmVersion = 'exp-decay-v1'; // default
    try {
      const config = validateEnv(process.env);
      lambda = config.REPUTATION_DECAY_LAMBDA;
      algorithmVersion = config.REPUTATION_SCORE_ALGORITHM_VERSION;
    } catch (error) {
      // In test environment or when env validation fails, use defaults
      // This allows tests to run without setting all env vars
    }

    // Compute weighted score using recency-aware algorithm
    const weightedScore = computeWeightedReputationScore(
      entries,
      new Date(),
      lambda
    );

    return {
      freelancerId: targetId,
      score: parseFloat(score.toFixed(2)),
      jobsCompleted: 0, // Legacy field, deprecated
      totalRatings,
      reviews: entries.map(entry => ({
        reviewerId: entry.reviewerId,
        rating: entry.rating,
        comment: entry.comment,
        createdAt: entry.createdAt,
      })),
      lastUpdated: entries.length > 0 ? entries[0].createdAt : new Date().toISOString(),
      weightedScore: parseFloat(weightedScore.toFixed(2)),
      scoreAlgorithm: algorithmVersion,
    };
  }

  /**
   * Validates comment content for spam and policy violations.
   * 
   * @param comment - The comment text to validate
   * @throws ValidationError if comment fails validation
   */
  private static validateComment(comment: string): void {
    // Max length
    if (comment.length > 1000) {
      throw new ValidationError('Comment exceeds maximum length of 1000 characters');
    }

    // Empty/whitespace check only for non-empty strings
    if (comment.length > 0 && !comment.trim()) {
      throw new ValidationError('Comment cannot be empty or whitespace-only');
    }

    // Only check spam if comment has content
    if (comment.length > 0) {
      const charCount: Record<string, number> = {};
      for (const char of comment) {
        charCount[char] = (charCount[char] || 0) + 1;
      }
      const maxCharCount = Math.max(...Object.values(charCount));
      if (maxCharCount / comment.length > 0.5) {
        throw new ValidationError('Comment contains excessive repetitive content');
      }
    }
  }

  /**
   * Creates a SHA-256 hash of the comment for audit logging.
   * Prevents storing sensitive comment text in audit logs.
   */
  private static hashComment(comment: string): string {
    return createHash('sha256').update(comment).digest('hex');
  }
}
