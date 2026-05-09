// api/admin-pojk.js
// GET  /api/admin-pojk          → list semua POJK (admin)
// DELETE /api/admin-pojk        → hapus POJK by id (admin)

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  try {
    const [payloadB64] = token.split('.')
    const payload = JSON.parse(atob(payloadB64))
    // Cek expiry
    if (payload.exp && Date.now() > payload.exp) return null
    // Cek role
    if (payload.role !== 'admin') return null
    return payload
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const user = await verifyToken(req.headers.authorization)
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized. Login sebagai admin.' })
  }

  // ── GET: list POJK ──
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('pojk_list')
        .select('id, nomor, nama, tahun, jumlah_pasal, file_url')
        .order('tahun', { ascending: false })

      if (error) throw error
      return res.status(200).json({ pojk: data || [] })
    } catch (err) {
      console.error('admin-pojk GET error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  // ── DELETE: hapus POJK ──
  if (req.method === 'DELETE') {
    const { id } = req.body || {}
    if (!id) return res.status(400).json({ error: 'ID wajib diisi.' })

    try {
      // Hapus chunks dulu
      const { error: chunkErr } = await supabase
        .from('pojk_chunks')
        .delete()
        .eq('pojk_id', id)
      if (chunkErr) throw chunkErr

      // Hapus dari pojk_list
      const { error: listErr } = await supabase
        .from('pojk_list')
        .delete()
        .eq('id', id)
      if (listErr) throw listErr

      return res.status(200).json({ success: true, message: 'POJK berhasil dihapus.' })
    } catch (err) {
      console.error('admin-pojk DELETE error:', err)
      return res.status(500).json({ error: err.message })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
