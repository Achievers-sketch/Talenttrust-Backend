import { timingSafeEqual } from 'crypto';
import { containsUnsafeContent } from '../errors/safeErrors';
import {
  constantTimeCompareHex,
  createWebhookSignature,
  generateSignature,
  normalizeSignatureHeader,
  verifySignature,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEX_LENGTH,
  WEBHOOK_VERIFICATION_CODES,
} from './webhook-signing.util';

describe('Webhook Signing Utility', () => {
  const secret = 'test-webhook-secret';
  const payload = { event: 'user.created', data: { id: '123', email: 'test@example.com' } };
  const fixedNow = 1_700_000_000_000;

  describe('generateSignature', () => {
    it('generates a consistent HMAC signature for the same input', () => {
      const timestamp = 1640995200000;
      const signature1 = generateSignature(payload, secret, timestamp);
      const signature2 = generateSignature(payload, secret, timestamp);

      expect(signature1).toBe(signature2);
      expect(signature1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('generates different signatures for different timestamps', () => {
      const signature1 = generateSignature(payload, secret, 1640995200000);
      const signature2 = generateSignature(payload, secret, 1640995201000);
      expect(signature1).not.toBe(signature2);
    });

    it('generates different signatures for different secrets', () => {
      const timestamp = 1640995200000;
      expect(generateSignature(payload, 'secret1', timestamp)).not.toBe(
        generateSignature(payload, 'secret2', timestamp),
      );
    });
  });

  describe('normalizeSignatureHeader', () => {
    it('strips sha256= prefix and lowercases hex', () => {
      const hex = 'A'.repeat(WEBHOOK_SIGNATURE_HEX_LENGTH);
      expect(normalizeSignatureHeader(`sha256=${hex}`)).toBe(hex.toLowerCase());
    });

    it('returns null for non-hex garbage', () => {
      expect(normalizeSignatureHeader('not-hex!')).toBeNull();
      expect(normalizeSignatureHeader('')).toBeNull();
      expect(normalizeSignatureHeader(null)).toBeNull();
      expect(normalizeSignatureHeader('sha256=')).toBeNull();
      expect(normalizeSignatureHeader(`sha256=${'ab'.repeat(200)}`)).toBeNull();
    });
  });

  describe('verifySignature', () => {
    it('verifies a valid signature', () => {
      const timestamp = fixedNow;
      const signature = generateSignature(payload, secret, timestamp);
      expect(verifySignature(payload, signature, timestamp, secret, { now: fixedNow })).toBe(true);
    });

    it('accepts sha256= prefixed header values', () => {
      const timestamp = fixedNow;
      const signature = `sha256=${generateSignature(payload, secret, timestamp)}`;
      expect(verifySignature(payload, signature, timestamp, secret, { now: fixedNow })).toBe(true);
    });

    it('rejects an invalid signature', () => {
      const timestamp = fixedNow;
      expect(verifySignature(payload, 'invalid-signature', timestamp, secret, { now: fixedNow })).toBe(
        false,
      );
    });

    it('rejects a signature with wrong secret', () => {
      const timestamp = fixedNow;
      const signature = generateSignature(payload, secret, timestamp);
      expect(verifySignature(payload, signature, timestamp, 'wrong-secret', { now: fixedNow })).toBe(
        false,
      );
    });

    it('rejects a signature with modified payload', () => {
      const timestamp = fixedNow;
      const signature = generateSignature(payload, secret, timestamp);
      expect(
        verifySignature({ ...payload, data: { id: '456' } }, signature, timestamp, secret, {
          now: fixedNow,
        }),
      ).toBe(false);
    });

    it('rejects an old timestamp (more than 5 minutes)', () => {
      const oldTimestamp = fixedNow - 6 * 60 * 1000;
      const signature = generateSignature(payload, secret, oldTimestamp);
      expect(verifySignature(payload, signature, oldTimestamp, secret, { now: fixedNow })).toBe(false);
    });

    it('accepts a recent timestamp (less than 5 minutes)', () => {
      const recentTimestamp = fixedNow - 4 * 60 * 1000;
      const signature = generateSignature(payload, secret, recentTimestamp);
      expect(verifySignature(payload, signature, recentTimestamp, secret, { now: fixedNow })).toBe(
        true,
      );
    });

    it('accepts a timestamp exactly at the 5-minute boundary', () => {
      const exactly5Minutes = fixedNow - 5 * 60 * 1000;
      const signature = generateSignature(payload, secret, exactly5Minutes);
      expect(
        verifySignature(payload, signature, exactly5Minutes, secret, { now: fixedNow }),
      ).toBe(true);
    });

    it('rejects wrong-length hex digests', () => {
      const timestamp = fixedNow;
      const shortSig = generateSignature(payload, secret, timestamp).slice(0, 32);
      expect(verifySignature(payload, shortSig, timestamp, secret, { now: fixedNow })).toBe(false);
    });
  });

  describe('verifyWebhookSignature', () => {
    it('rejects missing or empty secrets', () => {
      const timestamp = fixedNow;
      const signature = generateSignature(payload, secret, timestamp);
      expect(
        verifyWebhookSignature(payload, signature, timestamp, '', { now: fixedNow }).code,
      ).toBe(WEBHOOK_VERIFICATION_CODES.MISSING_SECRET);
    });

    it('returns safe failure messages without unsafe content', () => {
      const result = verifyWebhookSignature(payload, 'zz', fixedNow, secret, { now: fixedNow });
      expect(result.valid).toBe(false);
      expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.INVALID_SIGNATURE_FORMAT);
      expect(containsUnsafeContent(result.message)).toBe(false);
    });

    it('maps timestamp expiry to unauthorized code', () => {
      const oldTimestamp = fixedNow - 6 * 60 * 1000;
      const signature = generateSignature(payload, secret, oldTimestamp);
      const result = verifyWebhookSignature(payload, signature, oldTimestamp, secret, {
        now: fixedNow,
      });
      expect(result.code).toBe(WEBHOOK_VERIFICATION_CODES.TIMESTAMP_EXPIRED);
    });
  });

  describe('constantTimeCompareHex', () => {
    it('returns false for empty digests without throwing', () => {
      expect(constantTimeCompareHex('', '')).toBe(false);
    });

    it('delegates equal digests to timingSafeEqual', () => {
      const digest = generateSignature(payload, secret, fixedNow);
      const left = Buffer.from(digest, 'hex');
      const right = Buffer.from(digest, 'hex');
      expect(constantTimeCompareHex(digest, digest)).toBe(timingSafeEqual(left, right));
    });
  });

  describe('Integration Tests', () => {
    it('works end-to-end: create signature and verify it', () => {
      const { signature, timestamp } = createWebhookSignature(payload, secret);
      expect(verifySignature(payload, signature, timestamp, secret, { now: Date.now() })).toBe(true);
    });

    it('uses the system clock when options are omitted', () => {
      const { signature, timestamp } = createWebhookSignature(payload, secret);
      expect(verifyWebhookSignature(payload, signature, timestamp, secret).valid).toBe(true);
    });
  });
});
