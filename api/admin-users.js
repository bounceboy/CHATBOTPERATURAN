import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function verifyToken(req) {
  const auth = req.headers.authorization || ''
  const token = auth.replace('Bearer ', '')
  if (!token) return null
  try {
    const payload = JSON.parse(atob(token.split('.')[0]))
    if (payload.exp < Date.now()) return null
    return payload
  } catch { return null }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const user = await verifyToken(req)
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Akses ditolak.' })

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('core_users')
      .select('id, username, nama_lengkap, role, status, created_at, last_login')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ users: data })
  }

  if (req.method === 'POST') {
    const { username, password, nama_lengkap, role } = req.body || {}
    if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib.' })
    const { data, error } = await supabase.from('core_users').insert({
      username: username.trim(), password_hash: password,
      nama_lengkap: nama_lengkap || null, role: role || 'user', status: 'active'
    }).select('id, username, nama_lengkap, role, status').single()
    if (error) return res.status(400).json({ error: error.code === '23505' ? 'Username sudah dipakai.' : error.message })
    return res.status(201).json({ user: data })
  }

  if (req.method === 'PATCH') {
    const { id, status, role, password, nama_lengkap } = req.body || {}
    if (!id) return res.status(400).json({ error: 'ID user wajib.' })
    const updates = {}
    if (status !== undefined) updates.status = status
    if (role !== undefined) updates.role = role
    if (password) updates.password_hash = password
    if (nama_lengkap !== undefined) updates.nama_lengkap = nama_lengkap
    const { error } = await supabase.from('core_users').update(updates).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ success: true })
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {}
    if (!id) return res.status(400).json({ error: 'ID user wajib.' })
    const { error } = await supabase.from('core_users').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ success: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
