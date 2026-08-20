import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'

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