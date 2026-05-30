import { createPublicKey, type KeyObject, verify } from 'node:crypto'

export type RequestSignatureHeader = string | undefined

type ParsedSignatureHeader = {
  timestamp: string
  signature: string
}

type VerifySignedRequestOptions = {
  publicAPIKey: string
  payload: string
  header: RequestSignatureHeader
}

type VerifySignedRequestResult =
  | {
      ok: true
    }
  | {
      ok: false
      error: string
    }

export function buildSignedPayload({
  method,
  rawQuery,
  rawBody,
}: {
  method: string
  rawQuery?: string
  rawBody?: string
}) {
  const normalizedMethod = method.toUpperCase()

  if (normalizedMethod === 'GET' || normalizedMethod === 'DELETE') {
    return rawQuery ?? ''
  }

  return rawBody ?? ''
}

export function verifySignedRequest({
  publicAPIKey,
  payload,
  header,
}: VerifySignedRequestOptions): VerifySignedRequestResult {
  const parsedHeader = parseSignatureHeader(header)
  if (!parsedHeader) {
    return {
      ok: false,
      error:
        'Missing or invalid x-zenstack-signature header. Expected format: t=<unix timestamp>,v1=<signature>.',
    }
  }

  const publicKey = parsePublicKey(publicAPIKey)
  if (!publicKey) {
    return {
      ok: false,
      error:
        'Invalid public API key. Expected a PEM public key or base64-encoded Ed25519 SPKI key.',
    }
  }

  const { timestamp, signature } = parsedHeader
  const message = `${payload}${timestamp}`

  try {
    const isValid = verify(
      null,
      Buffer.from(message, 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64url')
    )

    return isValid ? { ok: true } : { ok: false, error: 'Invalid request signature.' }
  } catch {
    return { ok: false, error: 'Invalid request signature.' }
  }
}

function parseSignatureHeader(header: RequestSignatureHeader): ParsedSignatureHeader | null {
  if (!header) {
    return null
  }

  const values = header.split(',').reduce<Record<string, string>>((result, item) => {
    const [key, ...valueParts] = item.trim().split('=')
    if (key && valueParts.length > 0) {
      result[key] = valueParts.join('=')
    }
    return result
  }, {})

  if (!values.t || !values.v1 || !/^\d+$/.test(values.t)) {
    return null
  }

  return {
    timestamp: values.t,
    signature: values.v1,
  }
}

function parsePublicKey(publicAPIKey: string): KeyObject | null {
  const trimmedKey = publicAPIKey.trim()

  try {
    if (trimmedKey.includes('BEGIN PUBLIC KEY')) {
      return createPublicKey(trimmedKey)
    }

    return createPublicKey({
      key: Buffer.from(trimmedKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    return null
  }
}
