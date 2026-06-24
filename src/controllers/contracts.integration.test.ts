/**
 * Integration tests for Contract CRUD routes — JWT auth and RBAC.
 *
 * Covers:
 *  - 401 when no token / malformed header / expired token
 *  - 403 when authenticated but wrong role or non-owner
 *  - 200 / 201 for authorised callers
 *  - Owner-only enforcement on PATCH and DELETE
 *  - No information leakage in 401/403 responses
 *  - Error envelope shape { error: { code, message, requestId } }
 */

// Set env vars BEFORE any imports so singletons pick them up.
process.env.JWT_SECRET = 'contracts-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { closeDb, getDb } from '../db/database';
import app from '../index';

// ─── Token helpers ────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;

// UUIDs that match the seeded users created in beforeAll.
const CLIENT_ID     = '00000000-0000-0000-0000-000000000001';
const FREELANCER_ID = '00000000-0000-0000-0000-000000000002';

function makeToken(role: string, sub = 'user-1', expiresIn: number | string = '1h'): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, { expiresIn } as any) as string;
}

const adminToken      = () => makeToken('admin', 'admin-1');
const clientToken     = (id = CLIENT_ID) => makeToken('client', id);
const freelancerToken = (id = FREELANCER_ID) => makeToken('freelancer', id);

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Shared contract payload ───────────────────────────────────────────────

const validPayload = {
  title: 'Test Contract Title',
  description: 'This is a valid long enough description for testing.',
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 5000,
};

// ─── Seed users for FK constraints ──────────────────────────────────────────

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  // Insert with specific IDs so our tokens (which carry these as `sub`) match
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_ID, 'testclient', 'testclient@test.com', 'client', now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(FREELANCER_ID, 'testfreelancer', 'testfreelancer@test.com', 'freelancer', now);
});

afterAll(() => {
  closeDb();
});

// ─── Helper: create a contract as admin ─────────────────────────────────────

async function createContractAsAdmin(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set(auth(adminToken()))
    .send(validPayload);
  expect(res.status).toBe(201);
  return (res.body as { data: { id: string } }).data.id;
}

// ─── GET /api/v1/contracts ────────────────────────────────────────────────────

describe('GET /api/v1/contracts', () => {
  it('returns 401 when no Authorization header', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized' });
  });

  it('returns 401 for malformed Authorization header (no Bearer prefix)', async () => {
    const res = await request(app).get('/api/v1/contracts').set('Authorization', 'Token not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const expired = makeToken('admin', 'u1', -1);
    const res = await request(app).get('/api/v1/contracts').set(auth(expired));
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/expired/i);
  });

  it('returns 401 for a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ sub: 'x', email: 'x@x.com', role: 'admin' }, 'wrong-secret');
    const res = await request(app).get('/api/v1/contracts').set(auth(forged));
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app).get('/api/v1/contracts').set(auth(adminToken()));
    expect(res.status).toBe(200);
  });

  it('returns 403 for client (list is ownOnly; no owner resolver on collection route)', async () => {
    // The permission matrix marks client.contracts.list as ownOnly.
    // A collection route has no single resource id to resolve ownership against,
    // so requirePermission correctly denies access.
    const res = await request(app).get('/api/v1/contracts').set(auth(clientToken()));
    expect(res.status).toBe(403);
  });

  it('returns 403 for freelancer (list is ownOnly)', async () => {
    const res = await request(app).get('/api/v1/contracts').set(auth(freelancerToken()));
    expect(res.status).toBe(403);
  });

  it('does not leak user id or token contents on 401', async () => {
    const forged = jwt.sign({ sub: 'secret-id', email: 'x@x.com', role: 'admin' }, 'wrong-secret');
    const res = await request(app).get('/api/v1/contracts').set(auth(forged));
    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('secret-id');
    expect(body).not.toContain(forged);
  });
});

// ─── POST /api/v1/contracts ───────────────────────────────────────────────────

describe('POST /api/v1/contracts', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).post('/api/v1/contracts').send(validPayload);
    expect(res.status).toBe(401);
  });

  it('returns 201 for admin with valid payload', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(adminToken()))
      .send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.title).toBe(validPayload.title);
  });

  it('returns 201 for client (create is permitted)', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(clientToken()))
      .send(validPayload);
    expect(res.status).toBe(201);
  });

  it('returns 403 for freelancer (create not in permission matrix)', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(freelancerToken()))
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('returns 400 for admin with invalid payload (missing title)', async () => {
    const { title: _t, ...noTitle } = validPayload;
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(adminToken()))
      .send(noTitle);
    expect(res.status).toBe(400);
  });

  it('returns 400 for admin with negative budget', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(adminToken()))
      .send({ ...validPayload, budget: -100 });
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/v1/contracts/:id ────────────────────────────────────────────────

describe('GET /api/v1/contracts/:id', () => {
  let contractId: string;

  beforeAll(async () => {
    contractId = await createContractAsAdmin();
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get(`/api/v1/contracts/${contractId}`);
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(contractId);
  });

  it('returns 200 for the owning client (sub === clientId)', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(clientToken(CLIENT_ID)));
    expect(res.status).toBe(200);
  });

  it('returns 403 for a non-owning client', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(clientToken('00000000-0000-0000-0000-000000000099')));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('returns 404 for a non-existent contract id', async () => {
    const res = await request(app)
      .get('/api/v1/contracts/00000000-0000-0000-0000-000000000000')
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
  });

  it('does not reveal resource existence to non-owner (returns 403, not 200/404)', async () => {
    const nonOwner = clientToken('00000000-0000-0000-0000-000000000099');
    const res = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(nonOwner));
    expect(res.status).toBe(403);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(contractId);
    expect(body).not.toContain(CLIENT_ID);
  });
});

// ─── PATCH /api/v1/contracts/:id ─────────────────────────────────────────────

describe('PATCH /api/v1/contracts/:id', () => {
  let contractId: string;
  let contractVersion: number;

  beforeAll(async () => {
    contractId = await createContractAsAdmin();
    const fetched = await request(app)
      .get(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()));
    contractVersion = (fetched.body as { data: { version: number } }).data.version;
  });

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .send({ version: contractVersion, title: 'No Auth Update' });
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ version: contractVersion, title: 'Admin Updated Title' });
    expect(res.status).toBe(200);
    contractVersion = (res.body as { data: { version: number } }).data.version;
  });

  it('returns 200 for the owning client', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(clientToken(CLIENT_ID)))
      .send({ version: contractVersion, title: 'Client Updated Title' });
    expect(res.status).toBe(200);
    contractVersion = (res.body as { data: { version: number } }).data.version;
  });

  it('returns 403 for a non-owning client', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(clientToken('00000000-0000-0000-0000-000000000099')))
      .send({ version: contractVersion, title: 'Malicious Update' });
    expect(res.status).toBe(403);
  });

  it('returns 403 for a freelancer (not the owner by clientId)', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(freelancerToken(FREELANCER_ID)))
      .send({ version: contractVersion, title: 'Freelancer Update' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a non-existent contract id', async () => {
    const res = await request(app)
      .patch('/api/v1/contracts/00000000-0000-0000-0000-000000000000')
      .set(auth(adminToken()))
      .send({ version: 0, title: 'Ghost Update' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for admin with invalid body (missing version)', async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}`)
      .set(auth(adminToken()))
      .send({ title: 'No version field' });
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /api/v1/contracts/:id ────────────────────────────────────────────

describe('DELETE /api/v1/contracts/:id', () => {
  it('returns 401 without a token', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app).delete(`/api/v1/contracts/${id}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for a client (delete not in client permission matrix)', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(clientToken(CLIENT_ID)));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('returns 403 for a freelancer', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(freelancerToken()));
    expect(res.status).toBe(403);
  });

  it('returns 200 for admin', async () => {
    const id = await createContractAsAdmin();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
  });

  it('returns 404 for a non-existent contract id (admin)', async () => {
    const res = await request(app)
      .delete('/api/v1/contracts/00000000-0000-0000-0000-000000000000')
      .set(auth(adminToken()));
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/v1/contracts/stats ─────────────────────────────────────────────

describe('GET /api/v1/contracts/stats', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/contracts/stats');
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app).get('/api/v1/contracts/stats').set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('total');
  });
});

// ─── GET /api/v1/contracts/bounds ────────────────────────────────────────────

describe('GET /api/v1/contracts/bounds', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/contracts/bounds');
    expect(res.status).toBe(401);
  });

  it('returns 200 for admin', async () => {
    const res = await request(app).get('/api/v1/contracts/bounds').set(auth(adminToken()));
    expect(res.status).toBe(200);
  });
});

// ─── Error envelope shape ─────────────────────────────────────────────────────

describe('Error envelope', () => {
  it('401 response has { error: { code, message, requestId } }', async () => {
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('requestId');
  });

  it('403 response has { error: { code, message, requestId } }', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set(auth(freelancerToken()))
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
    expect(res.body.error).toHaveProperty('message');
    expect(res.body.error).toHaveProperty('requestId');
  });
});
