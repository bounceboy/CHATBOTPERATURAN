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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const user = await verifyToken(req)
  if (!user) return res.status(401).json({ error: 'Unauthorized' })

  // GET /api/sessions — daftar semua sesi user
  if (req.method === 'GET' && !req.query.id) {
    const { data, error } = await supabase
      .from('core_sessions')
      .select('id, title, created_at, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(50)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ sessions: data })
  }

  // GET /api/sessions?id=xxx — ambil pesan di sesi tertentu
  if (req.method === 'GET' && req.query.id) {
    const { data, error } = await supabase
      .from('core_messages')
      .select('id, role, content, sources, created_at')
      .eq('session_id', req.query.id)
      .order('created_at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ messages: data })
  }

  // POST /api/sessions — buat sesi baru atau tambah pesan
  if (req.method === 'POST') {
    const { action, session_id, title, role, content, sources } = req.body || {}

    // Buat sesi baru
    if (action === 'create') {
      const { data, error } = await supabase
        .from('core_sessions')
        .insert({ user_id: user.id, title: title || 'Sesi baru' })
        .select('id, title, created_at')
        .single()
      if (error) return res.status(500).json({ error: error.message })
      return res.status(201).json({ session: data })
    }

    // Tambah pesan ke sesi
    if (action === 'message') {
      if (!session_id || !role || !content) return res.status(400).json({ error: 'session_id, role, content wajib.' })
      const { error: msgErr } = await supabase
        .from('core_messages')
        .insert({ session_id, role, content, sources: sources || null })
      if (msgErr) return res.status(500).json({ error: msgErr.message })
      // Update updated_at sesi
      await supabase.from('core_sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id)
      return res.status(201).json({ success: true })
    }

    // Update judul sesi
    if (action === 'rename') {
      await supabase.from('core_sessions').update({ title }).eq('id', session_id).eq('user_id', user.id)
      return res.status(200).json({ success: true })
    }
  }

  // DELETE /api/sessions — hapus sesi
  if (req.method === 'DELETE') {
    const { session_id } = req.body || {}
    if (!session_id) return res.status(400).json({ error: 'session_id wajib.' })
    await supabase.from('core_sessions').delete().eq('id', session_id).eq('user_id', user.id)
    return res.status(200).json({ success: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
