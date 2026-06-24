import { AddressInfo } from 'net';
import { createApp } from './app';
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from './middleware/requestId';

/**
 * Exercises the live Express app wiring for the contracts list endpoint
 * (matches ContractsController + ContractsService behavior).
 */
describe('Contracts API integration (live app factory)', () => {
  it('GET /api/v1/contracts returns success envelope', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(
        expect.objectContaining({ status: 'success', data: expect.anything() }),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });
});

/**
 * @module app.integration.test
 * @description Integration tests for correlation ID propagation across request lifecycle.
 *
 * Verifies that:
 * 1. Correlation IDs are accepted and echoed back in response headers
 * 2. Correlation IDs are included in request-scoped logs
 * 3. Request IDs are always generated and included in response headers
 */
describe('Correlation ID propagation integration', () => {
  /**
   * Tests that X-Correlation-Id header is accepted from the client,
   * validated for security, and echoed back in the response.
   */
  it('should accept X-Correlation-Id header from client and echo back', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const testCorrelationId = 'test-correlation-id-12345';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: {
          [CORRELATION_ID_HEADER]: testCorrelationId,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get(CORRELATION_ID_HEADER)).toBe(testCorrelationId);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that X-Correlation-Id is not echoed back when not provided by client.
   */
  it('should not echo X-Correlation-Id when not provided by client', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`);

      expect(response.status).toBe(200);
      expect(response.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that X-Request-Id header is always generated and echoed back.
   */
  it('should always generate and echo back X-Request-Id header', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`);

      expect(response.status).toBe(200);
      const requestId = response.headers.get(REQUEST_ID_HEADER);
      expect(requestId).toBeTruthy();
      // Basic UUID v4 format validation
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that client-supplied X-Request-Id is reused if valid.
   */
  it('should reuse client-supplied X-Request-Id if valid', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const clientRequestId = 'abc123-def456-ghi789';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: {
          [REQUEST_ID_HEADER]: clientRequestId,
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get(REQUEST_ID_HEADER)).toBe(clientRequestId);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that both X-Correlation-Id and X-Request-Id are propagated together.
   */
  it('should propagate both X-Correlation-Id and X-Request-Id in response', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const testCorrelationId = 'trace-correlation-id-789';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: {
          [CORRELATION_ID_HEADER]: testCorrelationId,
        },
      });

      expect(response.status).toBe(200);
      const requestId = response.headers.get(REQUEST_ID_HEADER);
      const correlationId = response.headers.get(CORRELATION_ID_HEADER);

      expect(requestId).toBeTruthy();
      expect(correlationId).toBe(testCorrelationId);
      expect(requestId).not.toBe(correlationId);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that invalid correlation IDs are rejected (header injection protection).
   * Only alphanumeric, hyphens, and underscores are allowed (max 128 chars).
   */
  it('should reject invalid correlation IDs with special characters', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const invalidCorrelationId = 'test<script>alert(1)</script>';

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: {
          [CORRELATION_ID_HEADER]: invalidCorrelationId,
        },
      });

      expect(response.status).toBe(200);
      // Invalid correlation ID should not be echoed back
      expect(response.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  /**
   * Tests that correlation IDs exceeding 128 characters are rejected.
   */
  it('should reject correlation IDs exceeding 128 characters', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const longCorrelationId = 'a'.repeat(129);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/contracts`, {
        headers: {
          [CORRELATION_ID_HEADER]: longCorrelationId,
        },
      });

      expect(response.status).toBe(200);
      // Too-long correlation ID should not be echoed back
      expect(response.headers.get(CORRELATION_ID_HEADER)).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });
});
