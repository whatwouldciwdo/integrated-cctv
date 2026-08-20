import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored).split(':')
  if (!salt || !expectedHex) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export const newSessionToken = () => randomBytes(32).toString('base64url')
export const tokenDigest = (token) => createHash('sha256').update(token).digest('hex')

function encryptionKey(value) {
  const key = Buffer.from(String(value || ''), 'base64')
  if (key.length !== 32) throw Object.assign(new Error('RTSP_ENCRYPTION_KEY harus berupa 32 byte base64'), { status: 503 })
  return key
}

export function encryptSecret(value, keyValue) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':')
}

export function decryptSecret(value, keyValue) {
  const [version, ivValue, tagValue, encryptedValue] = String(value || '').split(':')
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) throw new Error('Format data RTSP terenkripsi tidak valid')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyValue), Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8')
}
