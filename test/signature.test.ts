import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import { sign } from 'node:crypto'
import request from 'supertest'
import {
  createSignatureMiddleware,
  normalizePublicKey,
  verifyEd25519Signature,
} from '../src/signature'

// ─── Ed25519 key pair for tests ───────────────────────────────────────────────

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHIlHXhk+zc9ziuvrYAnZZgGL36H1GXwfsYchM9dM8gR
-----END PRIVATE KEY-----`

const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFSJV7wjdFuDz2CqYX7hGnITQvcmJYy7OJQq2Cy2Eiqs=
-----END PUBLIC KEY-----`

/** Raw base64 DER — the same key without PEM markers. */
const TEST_PUBLIC_KEY_DER = 'MCowBQYDK2VwAyEAFSJV7wjdFuDz2CqYX7hGnITQvcmJYy7OJQq2Cy2Eiqs='

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds the `x-zenstack-signature` header value for a request.
 */
function buildSignatureHeader(options: {
  privateKey: string
  method: string
  pathWithQuery: string
  body?: unknown
  authorizationToken?: string
  timestamp?: string
}): string {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000))
  const method = options.method.toUpperCase()
  let payload: string
  if (method === 'GET' || method === 'DELETE') {
    const qMark = options.pathWithQuery.indexOf('?')
    payload = qMark >= 0 ? options.pathWithQuery.substring(qMark + 1) : ''
  } else {
    payload = options.body != null ? JSON.stringify(options.body) : ''
  }

  const message = options.authorizationToken
    ? `${payload}${timestamp}${options.authorizationToken}`
    : `${payload}${timestamp}`

  const sig = sign(null, Buffer.from(message, 'utf8'), options.privateKey).toString('base64url')
  return `t=${timestamp},v1=${sig}`
}

// ─── normalizePublicKey ────────────────────────────────────────────────────────

describe('normalizePublicKey', () => {
  it('returns PEM key unchanged', () => {
    const result = normalizePublicKey(TEST_PUBLIC_KEY)
    assert.strictEqual(result, TEST_PUBLIC_KEY)
  })

  it('wraps raw base64 DER in PEM markers', () => {
    const result = normalizePublicKey(TEST_PUBLIC_KEY_DER)
    assert.ok(result.includes('-----BEGIN PUBLIC KEY-----'))
    assert.ok(result.includes('-----END PUBLIC KEY-----'))
    assert.ok(result.includes(TEST_PUBLIC_KEY_DER))
  })

  it('converts base64url to standard base64 before wrapping', () => {
    const base64url = TEST_PUBLIC_KEY_DER.replace(/\+/g, '-').replace(/\//g, '_')
    const result = normalizePublicKey(base64url)
    // After normalization, the body should be standard base64 (no `-` or `_`)
    const body = result
      .replace('-----BEGIN PUBLIC KEY-----\n', '')
      .replace('\n-----END PUBLIC KEY-----', '')
    assert.doesNotMatch(body, /[-_]/)
  })

  it('trims leading/trailing whitespace', () => {
    const result = normalizePublicKey(`  ${TEST_PUBLIC_KEY_DER}  `)
    assert.ok(result.includes('-----BEGIN PUBLIC KEY-----'))
    assert.ok(result.includes('-----END PUBLIC KEY-----'))
  })
})

// ─── verifyEd25519Signature ────────────────────────────────────────────────────

describe('verifyEd25519Signature', () => {
  const normalizedKey = normalizePublicKey(TEST_PUBLIC_KEY)

  it('returns true for a valid signature', () => {
    const message = 'hello world'
    const sig = sign(null, Buffer.from(message, 'utf8'), TEST_PRIVATE_KEY).toString('base64url')
    assert.ok(verifyEd25519Signature(normalizedKey, message, sig))
  })

  it('returns false for a tampered message', () => {
    const message = 'hello world'
    const sig = sign(null, Buffer.from(message, 'utf8'), TEST_PRIVATE_KEY).toString('base64url')
    assert.ok(!verifyEd25519Signature(normalizedKey, 'tampered message', sig))
  })

  it('returns false for a garbage signature', () => {
    assert.ok(!verifyEd25519Signature(normalizedKey, 'hello', 'notavalidsig'))
  })

  it('returns false for an empty signature', () => {
    assert.ok(!verifyEd25519Signature(normalizedKey, 'hello', ''))
  })

  it('works with a raw DER key after normalization', () => {
    const message = 'test-message'
    const sig = sign(null, Buffer.from(message, 'utf8'), TEST_PRIVATE_KEY).toString('base64url')
    assert.ok(verifyEd25519Signature(normalizePublicKey(TEST_PUBLIC_KEY_DER), message, sig))
  })
})

// ─── createSignatureMiddleware ─────────────────────────────────────────────────

describe('createSignatureMiddleware', () => {
  function buildApp(publicKey: string, toleranceSecs = 60) {
    const app = express()
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          ;(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8')
        },
      })
    )
    app.use(createSignatureMiddleware(normalizePublicKey(publicKey), toleranceSecs))
    app.get('/ping', (_req, res) => res.json({ ok: true }))
    app.post('/ping', (_req, res) => res.json({ ok: true }))
    app.put('/ping', (_req, res) => res.json({ ok: true }))
    return app
  }

  describe('missing / malformed header', () => {
    it('returns 401 when x-zenstack-signature header is absent', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const res = await request(app).get('/ping')
      assert.strictEqual(res.status, 401)
      assert.match(res.body.message, /missing/i)
    })

    it('returns 401 when the header format is invalid', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const res = await request(app).get('/ping').set('x-zenstack-signature', 'garbage')
      assert.strictEqual(res.status, 401)
      assert.match(res.body.message, /invalid.*format/i)
    })

    it('returns 401 when t= part is missing', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const res = await request(app).get('/ping').set('x-zenstack-signature', 'v1=abc')
      assert.strictEqual(res.status, 401)
    })

    it('returns 401 when v1= part is missing', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const res = await request(app)
        .get('/ping')
        .set('x-zenstack-signature', `t=${Math.floor(Date.now() / 1000)}`)
      assert.strictEqual(res.status, 401)
    })
  })

  describe('timestamp validation', () => {
    it('returns 401 when timestamp is too old (default 60s window)', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 120)
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
        timestamp: expiredTimestamp,
      })
      const res = await request(app).get('/ping').set('x-zenstack-signature', sig)
      assert.strictEqual(res.status, 401)
      assert.match(res.body.message, /expired/i)
    })

    it('returns 401 when timestamp is too far in the future', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const futureTimestamp = String(Math.floor(Date.now() / 1000) + 120)
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
        timestamp: futureTimestamp,
      })
      const res = await request(app).get('/ping').set('x-zenstack-signature', sig)
      assert.strictEqual(res.status, 401)
      assert.match(res.body.message, /expired/i)
    })

    it('accepts a request within the custom tolerance window', async () => {
      const app = buildApp(TEST_PUBLIC_KEY, 300)
      const timestamp = String(Math.floor(Date.now() / 1000) - 120)
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
        timestamp,
      })
      const res = await request(app).get('/ping').set('x-zenstack-signature', sig)
      assert.strictEqual(res.status, 200)
    })

    it('rejects a request outside a tight custom tolerance', async () => {
      const app = buildApp(TEST_PUBLIC_KEY, 5)
      const timestamp = String(Math.floor(Date.now() / 1000) - 10)
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
        timestamp,
      })
      const res = await request(app).get('/ping').set('x-zenstack-signature', sig)
      assert.strictEqual(res.status, 401)
    })
  })

  describe('GET request signature', () => {
    it('accepts a valid GET request with no query params', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
      })
      const res = await request(app).get('/ping').set('x-zenstack-signature', sig)
      assert.strictEqual(res.status, 200)
    })

    it('accepts a valid GET request with query params', async () => {
      const appInner = express()
      appInner.use(
        express.json({
          verify: (req, _res, buf) => {
            ;(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8')
          },
        })
      )
      appInner.use(createSignatureMiddleware(normalizePublicKey(TEST_PUBLIC_KEY), 60))
      appInner.get('/search', (_req, res) => res.json({ ok: true }))

      const pathWithQuery = '/search?q=hello%20world&page=1'
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery,
      })
      const res = await request(appInner).get(pathWithQuery).set('x-zenstack-signature', sig)
      assert.strictEqual(res.status, 200)
    })

    it('rejects a GET request when query string is tampered', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      // Sign with original query, then send a different query
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping?foo=bar',
      })
      const res = await request(app).get('/ping?foo=tampered').set('x-zenstack-signature', sig)
      assert.strictEqual(res.status, 401)
    })
  })

  describe('POST request signature', () => {
    it('accepts a valid POST request with a JSON body', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const body = { data: { email: 'alice@example.com' } }
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'POST',
        pathWithQuery: '/ping',
        body,
      })
      const res = await request(app)
        .post('/ping')
        .set('x-zenstack-signature', sig)
        .set('Content-Type', 'application/json')
        .send(body)
      assert.strictEqual(res.status, 200)
    })

    it('rejects a POST request when the body is tampered', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const originalBody = { data: { email: 'alice@example.com' } }
      const tamperedBody = { data: { email: 'evil@example.com' } }
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'POST',
        pathWithQuery: '/ping',
        body: originalBody,
      })
      const res = await request(app)
        .post('/ping')
        .set('x-zenstack-signature', sig)
        .set('Content-Type', 'application/json')
        .send(tamperedBody)
      assert.strictEqual(res.status, 401)
    })
  })

  describe('PUT request signature', () => {
    it('accepts a valid PUT request', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const body = { where: { id: 'u1' }, data: { email: 'new@example.com' } }
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'PUT',
        pathWithQuery: '/ping',
        body,
      })
      const res = await request(app)
        .put('/ping')
        .set('x-zenstack-signature', sig)
        .set('Content-Type', 'application/json')
        .send(body)
      assert.strictEqual(res.status, 200)
    })
  })

  describe('Authorization header is included in the signed message', () => {
    it('rejects a request when the signature does not cover the Authorization header', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const authToken = Buffer.from(JSON.stringify({ type: 'superUser' })).toString('base64')
      // Sign WITHOUT including the auth token
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
      })
      const res = await request(app)
        .get('/ping')
        .set('x-zenstack-signature', sig)
        .set('Authorization', `Bearer ${authToken}`)
      assert.strictEqual(res.status, 401)
    })

    it('accepts a request when the signature covers the Authorization header', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const authToken = Buffer.from(JSON.stringify({ type: 'superUser' })).toString('base64')
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
        authorizationToken: authToken,
      })
      const res = await request(app)
        .get('/ping')
        .set('x-zenstack-signature', sig)
        .set('Authorization', `Bearer ${authToken}`)
      assert.strictEqual(res.status, 200)
    })

    it('rejects when the auth token is swapped after signing', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const originalToken = Buffer.from(JSON.stringify({ type: 'superUser' })).toString('base64')
      const differentToken = Buffer.from(
        JSON.stringify({ type: 'user', data: { id: 'u1' } })
      ).toString('base64')
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
        authorizationToken: originalToken,
      })
      const res = await request(app)
        .get('/ping')
        .set('x-zenstack-signature', sig)
        .set('Authorization', `Bearer ${differentToken}`)
      assert.strictEqual(res.status, 401)
    })
  })

  describe('public key format', () => {
    it('accepts a raw base64 DER key (without PEM markers)', async () => {
      const app = buildApp(TEST_PUBLIC_KEY_DER)
      const sig = buildSignatureHeader({
        privateKey: TEST_PRIVATE_KEY,
        method: 'GET',
        pathWithQuery: '/ping',
      })
      const res = await request(app).get('/ping').set('x-zenstack-signature', sig)
      assert.strictEqual(res.status, 200)
    })

    it('rejects an invalid signature with the correct key format', async () => {
      const app = buildApp(TEST_PUBLIC_KEY)
      const res = await request(app)
        .get('/ping')
        .set('x-zenstack-signature', `t=${Math.floor(Date.now() / 1000)},v1=invalidsignature`)
      assert.strictEqual(res.status, 401)
    })
  })
})
