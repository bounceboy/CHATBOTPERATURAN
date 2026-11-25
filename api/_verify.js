// Verifikasi token admin beserta tanda tangannya (format dibuat di api/auth.js)
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyAdmin(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    const [payloadB64, sig] = authHeader.slice(7).split('.')
    const json = Buffer.from(payloadB64, 'base64').toString('latin1')
    const secret = process.env.AUTH_SECRET || 'ojk-core-default-secret'
    const expected = createHmac('sha256', secret).update(json, 'utf8').digest()
    const given = Buffer.from(sig || '', 'base64')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    const payload = JSON.parse(json)
    if (payload.exp < Date.now() || payload.role !== 'admin') return null
    return payload
  } catch {
    return null
  }
}
