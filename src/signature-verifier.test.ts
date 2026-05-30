import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSignedPayload, verifySignedRequest } from './signature-verifier'

test('verifies sample GET signature using base64 DER public key', () => {
  const payload = buildSignedPayload({
    method: 'GET',
    rawQuery: 'q=%7B%22where%22%3A%7B%7D%2C%22take%22%3A100%2C%22skip%22%3A0%7D',
  })

  const result = verifySignedRequest({
    publicAPIKey: 'MCowBQYDK2VwAyEAFSJV7wjdFuDz2CqYX7hGnITQvcmJYy7OJQq2Cy2Eiqs=',
    payload,
    header:
      't=1777590674,v1=_Mbr9a-X24ZBUWQLGiPnehh99yBGXoMmfJ9Jh5N99E1uz4NpjZrCzdoKQZGCsYLRgYYJmCElsZ_6YT4FwlhZBQ',
  })

  assert.equal(result.ok, true)
})

test('verifies sample signature using PEM public key', () => {
  const payload = buildSignedPayload({
    method: 'GET',
    rawQuery: 'q=%7B%22where%22%3A%7B%7D%2C%22take%22%3A100%2C%22skip%22%3A0%7D',
  })

  const result = verifySignedRequest({
    publicAPIKey: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAFSJV7wjdFuDz2CqYX7hGnITQvcmJYy7OJQq2Cy2Eiqs=
-----END PUBLIC KEY-----`,
    payload,
    header:
      't=1777590674,v1=_Mbr9a-X24ZBUWQLGiPnehh99yBGXoMmfJ9Jh5N99E1uz4NpjZrCzdoKQZGCsYLRgYYJmCElsZ_6YT4FwlhZBQ',
  })

  assert.equal(result.ok, true)
})

test('verifies sample PUT signature using request body payload', () => {
  const payload = buildSignedPayload({
    method: 'PUT',
    rawBody: '{"data":{"meta":{"sessionNumber":15}},"where":{"id":"cmkhoq1t1000cb6av8sq9ql12"}}',
  })

  const result = verifySignedRequest({
    publicAPIKey: 'MCowBQYDK2VwAyEAFSJV7wjdFuDz2CqYX7hGnITQvcmJYy7OJQq2Cy2Eiqs=',
    payload,
    header:
      't=1777590954,v1=L_b8qi55lLv5XHfopAhC15qbJ_GAc-zGs8CUakXxnDh3Xce0seAC3Ri5mbEwVx27ckYV821wmaxJZt8fvFNnDA',
  })

  assert.equal(result.ok, true)
})

test('rejects invalid signatures', () => {
  const result = verifySignedRequest({
    publicAPIKey: 'MCowBQYDK2VwAyEAFSJV7wjdFuDz2CqYX7hGnITQvcmJYy7OJQq2Cy2Eiqs=',
    payload: '{}',
    header:
      't=1777590674,v1=_Mbr9a-X24ZBUWQLGiPnehh99yBGXoMmfJ9Jh5N99E1uz4NpjZrCzdoKQZGCsYLRgYYJmCElsZ_6YT4FwlhZBQ',
  })

  assert.deepEqual(result, {
    ok: false,
    error: 'Invalid request signature.',
  })
})

test('uses raw body for body-based requests', () => {
  assert.equal(
    buildSignedPayload({ method: 'POST', rawBody: '{"data":{"id":1}}' }),
    '{"data":{"id":1}}'
  )
  assert.equal(
    buildSignedPayload({ method: 'PUT', rawBody: '{"where":{"id":1}}' }),
    '{"where":{"id":1}}'
  )
})
