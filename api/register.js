import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).end()

  const { username, password, nama_lengkap } = req.body || {}
  if (!username || !password || !nama_lengkap) return res.status(400).json({ error: 'Semua field wajib diisi.' })
  if (password.length < 8) return res.status(400).json({ error: 'Password minimal 8 karakter.' })

  const { error } = await supabase.from('core_users').insert({
    username: username.trim(),
    password_hash: password,
    nama_lengkap: nama_lengkap.trim(),
    role: 'user',
    status: 'pending'
  })

  if (error) return res.status(400).json({ error: error.code === '23505' ? 'Username sudah dipakai.' : error.message })
  return res.status(201).json({ success: true })
}
