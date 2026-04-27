/**
 * @title Security Middleware Integration Tests
 * @notice Tests for CORS and Helmet middleware application
 */
import express, { Application } from 'express';
import request from 'supertest';
import { applySecurityMiddleware } from './security';

describe('Security Middleware Integration', () => {
    let app: Application;
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
        app = express();
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('CORS Middleware', () => {
        it('should allow requests from allowed origins', async () => {
            process.env.ALLOWED_ORIGINS = 'https://example.com';
            
            jest.isolateModules(() => {
                const { applySecurityMiddleware: applySecurity } = require('./security');
                applySecurity(app);
            });

            app.get('/test', (_req, res) => res.json({ success: true }));

            const response = await request(app)
                .get('/test')
                .set('Origin', 'https://example.com');

            expect(response.status).toBe(200);
            expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
        });

        it('should reject requests from disallowed origins', async () => {
            process.env.ALLOWED_ORIGINS = 'https://example.com';
            
            jest.isolateModules(() => {
                const { applySecurityMiddleware: applySecurity } = require('./security');
                applySecurity(app);
            });

            app.get('/test', (_req, res) => res.json({ success: true }));

            const response = await request(app)
                .get('/test')
                .set('Origin', 'https://malicious.com');

            expect(response.status).not.toBe(200);
        });


        it('should handle preflight OPTIONS requests', async () => {
            process.env.ALLOWED_ORIGINS = 'https://example.com';
            
            jest.isolateModules(() => {
                const { applySecurityMiddleware: applySecurity } = require('./security');
                applySecurity(app);
            });

            app.get('/test', (_req, res) => res.json({ success: true }));

            const response = await request(app)
                .options('/test')
                .set('Origin', 'https://example.com')
                .set('Access-Control-Request-Method', 'GET');

            expect(response.status).toBe(204);
            expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
            expect(response.headers['access-control-allow-methods']).toContain('GET');
        });

        it('should include credentials in CORS response', async () => {
            process.env.ALLOWED_ORIGINS = 'https://example.com';
            
            jest.isolateModules(() => {
                const { applySecurityMiddleware: applySecurity } = require('./security');
                applySecurity(app);
            });

            app.get('/test', (_req, res) => res.json({ success: true }));

            const response = await request(app)
                .get('/test')
                .set('Origin', 'https://example.com');

            expect(response.headers['access-control-allow-credentials']).toBe('true');
        });
    });

    describe('Helmet Middleware', () => {
        beforeEach(() => {
            applySecurityMiddleware(app);
            app.get('/test', (_req, res) => res.json({ success: true }));
        });

        it('should set Content-Security-Policy header', async () => {
            const response = await request(app).get('/test');

            expect(response.headers['content-security-policy']).toBeDefined();
            expect(response.headers['content-security-policy']).toContain("default-src 'self'");
        });

        it('should set Strict-Transport-Security header', async () => {
            const response = await request(app).get('/test');

            expect(response.headers['strict-transport-security']).toBeDefined();
            expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
        });

        it('should set Referrer-Policy header', async () => {
            const response = await request(app).get('/test');

            expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        });

        it('should set X-Content-Type-Options header', async () => {
            const response = await request(app).get('/test');

            expect(response.headers['x-content-type-options']).toBe('nosniff');
        });
    });

    describe('Combined Security Middleware', () => {
        it('should apply both CORS and Helmet headers', async () => {
            process.env.ALLOWED_ORIGINS = 'https://example.com';
            
            jest.isolateModules(() => {
                const { applySecurityMiddleware: applySecurity } = require('./security');
                applySecurity(app);
            });

            app.get('/test', (_req, res) => res.json({ success: true }));

            const response = await request(app)
                .get('/test')
                .set('Origin', 'https://example.com');

            // CORS headers
            expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
            expect(response.headers['access-control-allow-credentials']).toBe('true');

            // Helmet headers
            expect(response.headers['content-security-policy']).toBeDefined();
            expect(response.headers['strict-transport-security']).toBeDefined();
            expect(response.headers['x-content-type-options']).toBe('nosniff');
        });
    });
});
