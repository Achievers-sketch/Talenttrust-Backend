/**
 * @file error-envelope-contract.test.ts
 * @description Contract tests asserting API error envelope shape and error code stability.
 *
 * These tests prevent accidental breaking changes for clients by ensuring:
 * - Error response envelopes maintain consistent structure
 * - Error codes remain stable across different error types
 * - Response headers include proper request correlation data
 *
 * @security
 * - Validates that error responses never leak sensitive information
 * - Ensures proper content-type headers are set
 */

import { createApp } from '../app';
import { AppError, NotFoundError, UnauthorizedError, mapErrorToPayload } from '../errors/appError';
import express from 'express';
import http from 'http';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SimpleResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: {
        ...(body && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data }),
      );
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Contract Tests
// ---------------------------------------------------------------------------

describe('API Error Envelope Contract Tests', () => {
  let server: http.Server;

  beforeAll((done) => {
    server = createApp().listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  // ── Validation Error Envelope (400) ───────────────────────────────────────

  describe('Validation Error Envelope', () => {
    it('maintains consistent structure for validation errors', async () => {
      const res = await request(
        server,
        'POST',
        '/api/v1/contracts',
        JSON.stringify({ invalid: 'data' }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);

      const json = JSON.parse(res.body);
      
      // Contract: Validation errors must have this exact structure
      expect(json).toEqual({
        status: 'error',
        message: 'Validation failed',
        errors: expect.any(Array),
      });

      // Contract: Errors array must contain validation issue objects
      expect(Array.isArray(json.errors)).toBe(true);
      if (json.errors.length > 0) {
        expect(json.errors[0]).toEqual(
          expect.objectContaining({
            code: expect.any(String),
            message: expect.any(String),
            path: expect.any(Array),
          }),
        );
      }
    });

    it('includes request ID in response headers for validation errors', async () => {
      const res = await request(
        server,
        'POST',
        '/api/v1/contracts',
        JSON.stringify({ invalid: 'data' }),
        { 'x-request-id': 'test-validation-123' },
      );

      expect(res.headers['x-request-id']).toBe('test-validation-123');
    });
  });

  // ── Not Found Error Envelope (404) ─────────────────────────────────────────

  describe('Not Found Error Envelope', () => {
    it('maintains consistent structure for 404 errors', async () => {
      const res = await request(server, 'GET', '/api/v1/nonexistent');

      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);

      const json = JSON.parse(res.body);
      
      // Contract: 404 errors must have this exact structure
      expect(json).toEqual({
        error: 'Not Found',
      });
    });

    it('includes request ID in response headers for 404 errors', async () => {
      const res = await request(
        server,
        'GET',
        '/api/v1/nonexistent',
        undefined,
        { 'x-request-id': 'test-notfound-456' },
      );

      expect(res.headers['x-request-id']).toBe('test-notfound-456');
    });
  });

  // ── Dependency Unavailable Error Envelope (503) ─────────────────────────────

  describe('Dependency Unavailable Error Envelope', () => {
    let errorApp: express.Application;
    let errorServer: http.Server;

    beforeAll((done) => {
      // Create app that simulates dependency failure
      errorApp = express();
      errorApp.get('/dependency-fail', (req, res, next) => {
        const error = new AppError(503, 'dependency_unavailable', 'External service unavailable');
        next(error);
      });

      // Use the same error handling as main app
      errorApp.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
        const requestId = res.locals.requestId || 'unknown';
        const { statusCode, payload } = mapErrorToPayload(err, requestId);
        res.status(statusCode).json(payload);
      });

      errorServer = errorApp.listen(0, '127.0.0.1', done);
    });

    afterAll((done) => {
      void errorServer.close(done);
    });

    it('maintains consistent structure for dependency unavailable errors', async () => {
      const res = await request(
        errorServer,
        'GET',
        '/dependency-fail',
        undefined,
        { 'x-request-id': 'test-dep-unavailable-789' },
      );

      expect(res.statusCode).toBe(503);
      expect(res.headers['content-type']).toMatch(/application\/json/);

      const json = JSON.parse(res.body);
      
      // Contract: Dependency errors must have this exact structure
      expect(json).toEqual({
        error: {
          code: 'dependency_unavailable',
          message: 'External service unavailable',
          requestId: 'test-dep-unavailable-789',
        },
      });
    });

    it('includes request ID in error payload for dependency errors', async () => {
      const res = await request(
        errorServer,
        'GET',
        '/dependency-fail',
        undefined,
        { 'x-request-id': 'test-dep-payload-999' },
      );

      const json = JSON.parse(res.body);
      expect(json.error.requestId).toBe('test-dep-payload-999');
    });
  });

  // ── Internal Error Envelope (500) ───────────────────────────────────────────

  describe('Internal Error Envelope', () => {
    let errorApp: express.Application;
    let errorServer: http.Server;

    beforeAll((done) => {
      // Create app that simulates internal server error
      errorApp = express();
      errorApp.get('/internal-error', (req, res, next) => {
        // Simulate an unexpected error
        next(new Error('Database connection failed'));
      });

      // Use the same error handling as main app
      errorApp.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
        const requestId = res.locals.requestId || 'unknown';
        const { statusCode, payload } = mapErrorToPayload(err, requestId);
        res.status(statusCode).json(payload);
      });

      errorServer = errorApp.listen(0, '127.0.0.1', done);
    });

    afterAll((done) => {
      void errorServer.close(done);
    });

    it('maintains consistent structure for internal errors', async () => {
      const res = await request(
        errorServer,
        'GET',
        '/internal-error',
        undefined,
        { 'x-request-id': 'test-internal-000' },
      );

      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toMatch(/application\/json/);

      const json = JSON.parse(res.body);
      
      // Contract: Internal errors must have this exact structure
      expect(json).toEqual({
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred',
          requestId: 'test-internal-000',
        },
      });
    });

    it('does not leak sensitive error details in internal errors', async () => {
      const res = await request(errorServer, 'GET', '/internal-error');

      expect(res.body).not.toMatch(/Database connection failed/);
      expect(res.body).not.toMatch(/Error:/);
      expect(res.body).not.toMatch(/at Object/);
      expect(res.body).not.toMatch(/stack/);
    });

    it('includes request ID in error payload for internal errors', async () => {
      const res = await request(
        errorServer,
        'GET',
        '/internal-error',
        undefined,
        { 'x-request-id': 'test-internal-payload-111' },
      );

      const json = JSON.parse(res.body);
      expect(json.error.requestId).toBe('test-internal-payload-111');
    });
  });

  // ── Error Code Stability Tests ───────────────────────────────────────────

  describe('Error Code Stability', () => {
    it('ensures validation error codes remain stable', async () => {
      const res = await request(
        server,
        'POST',
        '/api/v1/contracts',
        JSON.stringify({ invalid: 'data' }),
      );

      const json = JSON.parse(res.body);
      
      // Contract: These error codes should never change
      expect(json.status).toBe('error');
      expect(json.message).toBe('Validation failed');
    });

    it('ensures AppError error codes remain stable', () => {
      // Test the error classes directly
      const notFoundError = new NotFoundError('Test resource not found');
      expect(notFoundError.statusCode).toBe(404);
      expect(notFoundError.code).toBe('not_found');

      const unauthorizedError = new UnauthorizedError('Test unauthorized');
      expect(unauthorizedError.statusCode).toBe(401);
      expect(unauthorizedError.code).toBe('unauthorized');
    });

    it('ensures mapErrorToPayload maintains stable structure', () => {
      const testRequestId = 'test-stability-123';
      
      // Test AppError mapping
      const appError = new AppError(422, 'validation_error', 'Test validation');
      const appResult = mapErrorToPayload(appError, testRequestId);
      
      expect(appResult).toEqual({
        statusCode: 422,
        payload: {
          error: {
            code: 'validation_error',
            message: 'Test validation',
            requestId: testRequestId,
          },
        },
      });

      // Test generic Error mapping
      const genericError = new Error('Something went wrong');
      const genericResult = mapErrorToPayload(genericError, testRequestId);
      
      expect(genericResult).toEqual({
        statusCode: 500,
        payload: {
          error: {
            code: 'internal_error',
            message: 'An unexpected error occurred',
            requestId: testRequestId,
          },
        },
      });
    });
  });

  // ── Header Contract Tests ────────────────────────────────────────────────

  describe('Response Header Contracts', () => {
    it('always includes content-type: application/json for error responses', async () => {
      const responses = await Promise.all([
        request(server, 'GET', '/nonexistent'), // 404
        request(server, 'POST', '/api/v1/contracts', JSON.stringify({})), // 400
      ]);

      responses.forEach(res => {
        expect(res.headers['content-type']).toMatch(/application\/json/);
      });
    });

    it('propagates request ID header for all error responses', async () => {
      const testRequestId = 'contract-test-123';
      const responses = await Promise.all([
        request(server, 'GET', '/nonexistent', undefined, { 'x-request-id': testRequestId }),
        request(server, 'POST', '/api/v1/contracts', JSON.stringify({}), { 'x-request-id': testRequestId }),
      ]);

      responses.forEach(res => {
        expect(res.headers['x-request-id']).toBe(testRequestId);
      });
    });

    it('generates request ID when not provided by client', async () => {
      const res = await request(server, 'GET', '/nonexistent');
      
      expect(res.headers['x-request-id']).toBeDefined();
      expect(typeof res.headers['x-request-id']).toBe('string');
      expect(res.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/); // UUID v4 format
    });
  });
});
