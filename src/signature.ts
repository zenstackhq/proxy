import { verify } from 'node:crypto'
import express from 'express'
import { yellow } from 'colors'

/**
 * Accepts a public key in either PEM format or as a raw base64 / base64url DER string
 * (without the `-----BEGIN PUBLIC KEY-----` markers) and always returns a PEM string.
 */
export function normalizePublicKey(key: string): string {
  key = key.trim()
  if (key.startsWith('-----BEGIN PUBLIC KEY-----')) {
    return key
  }
  // Convert base64url → standard base64, then wrap in PEM markers.
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/')
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`
}

/**
 * Verifies an ed25519 signature.
 *
 * @param publicKey  PEM-encoded public key (use normalizePublicKey first)
 * @param message    The message that was signed
 * @param sig        The base64url-encoded signature (the value after `v1=`)
 * @returns          true if the signature is valid, false otherwise
 */
export function verifyEd25519Signature(publicKey: string, message: string, sig: string): boolean {
  try {
    return verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(sig, 'base64url'))
  } catch {
    return false
  }
}

/**
 * Creates an Express middleware that verifies the ed25519 signature on every request.
 *
 * Signature header format: `x-zenstack-signature: t=<unix-timestamp>,v1=<base64url-signature>`
 *
 * The signed message is constructed as:
 *   - GET / DELETE requests: `<raw-query-string><timestamp>[<authorizationToken>]`
 *   - Other methods:         `<raw-body><timestamp>[<authorizationToken>]`
 *
 * `authorizationToken` is the bearer token value from the `Authorization` header (if present).
 */
export function createSignatureMiddleware(publicKey: string, toleranceSeconds: number) {
  // Throttle invalid-signature warnings to at most once per 60 seconds.
  let lastInvalidSigWarnAt = 0
  const WARN_THROTTLE_SECS = 60

  function warnInvalidSignature() {
    const now = Math.floor(Date.now() / 1000)
    if (now - lastInvalidSigWarnAt >= WARN_THROTTLE_SECS) {
      lastInvalidSigWarnAt = now
      console.warn(
        yellow(
          'Warning: Received a request with an invalid signature. ' +
            'Please double-check whether you have the correct public API key configured.'
        )
      )
    }
  }

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const signatureHeader = req.headers['x-zenstack-signature']
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return res.status(401).json({ message: 'Missing x-zenstack-signature header' })
    }

    const parts = signatureHeader.split(',')
    const timestampPart = parts.find((p) => p.startsWith('t='))
    const sigPart = parts.find((p) => p.startsWith('v1='))
    if (!timestampPart || !sigPart) {
      return res.status(401).json({ message: 'Invalid x-zenstack-signature format' })
    }
    const timestamp = timestampPart.substring(2)
    const sig = sigPart.substring(3)

    // Replay-attack prevention: reject requests whose timestamp deviates
    // from server time by more than the configured tolerance.
    const requestTime = parseInt(timestamp, 10)
    const now = Math.floor(Date.now() / 1000)
    if (isNaN(requestTime) || Math.abs(now - requestTime) > toleranceSeconds) {
      return res.status(401).json({ message: 'Request timestamp is expired or invalid' })
    }

    // Payload: raw query string for GET/DELETE, raw body for other methods.
    let payload: string
    if (req.method === 'GET' || req.method === 'DELETE') {
      const qMark = req.originalUrl.indexOf('?')
      payload = qMark >= 0 ? req.originalUrl.substring(qMark + 1) : ''
    } else {
      payload = (req as express.Request & { rawBody?: string }).rawBody ?? ''
    }

    // authorizationToken is the bearer token value (if present).
    const authHeader = req.headers['authorization']
    const authorizationToken =
      authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined

    const message = authorizationToken
      ? `${payload}${timestamp}${authorizationToken}`
      : `${payload}${timestamp}`

    if (!verifyEd25519Signature(publicKey, message, sig)) {
      warnInvalidSignature()
      return res.status(401).json({ message: 'Invalid signature' })
    }

    return next()
  }
}
