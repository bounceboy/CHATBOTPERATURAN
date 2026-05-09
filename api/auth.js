// api/auth.js — Admin login endpoint
// POST /api/auth  { username, password } → { token, username, role }

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Simple JWT-like token: base64(header.payload.signature)
// Signature = HMAC-SHA256 tidak tersedia di edge tanpa library,
// jadi kita pakai HMAC sederhana via Web Crypto API
async function signToken(payload) {
  const secret = process.env.AUTH_SECRET || 'ojk-core-default-secret'
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  )
  const data = encoder.encode(JSON.stringify(payload))
  const sig = await crypto.subtle.sign('HMAC', key, data)
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
  const payloadB64 = btoa(JSON.stringify(payload))
  return `${payloadB64}.${sigB64}`
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { username, password } = req.body || {}

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi.' })
  }

  try {
    // Cari user di tabel core_users
    const { data: user, error } = await supabase
      .from('core_users')
      .select('id, username, password, role')
      .eq('username', username.trim())
      .single()

    if (error || !user) {
      return res.status(401).json({ error: 'Username atau password salah.' })
    }

    // Compare password (plain text — untuk production gunakan bcrypt)
    if (user.password !== password) {
      return res.status(401).json({ error: 'Username atau password salah.' })
    }

    // Generate token
    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      iat: Date.now(),
      exp: Date.now() + (24 * 60 * 60 * 1000), // 24 jam
    }
    const token = await signToken(payload)

    return res.status(200).json({
      token,
      username: user.username,
      role: user.role,
    })

  } catch (err) {
    console.error('Auth error:', err)
    return res.status(500).json({ error: 'Terjadi kesalahan server.' })
  }
}
