// api/admin-embed.js
// POST /api/admin-embed  { pojk_id, chunks: [{ pasal, bab, bab_title, content, source, embedding }] }
// Tahap 2: Terima chunks yang sudah di-embed dari browser, simpan ke pojk_chunks

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  try {
    const token = authHeader.slice(7)
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    if (payload.exp && Date.now() / 1000 > payload.exp) return null
    if (payload.role !== 'admin') return null
    return payload
  } catch {
    return null
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await verifyToken(req.headers.authorization)
  if (!user) return res.status(401).json({ error: 'Unauthorized.' })

  const { pojk_id, chunks } = req.body || {}
  if (!pojk_id || !Array.isArray(chunks) || chunks.length === 0) {
    return res.status(400).json({ error: 'pojk_id dan chunks wajib diisi.' })
  }

  try {
    const chunksToInsert = chunks.map(c => ({
      pojk_id,
      pasal: c.pasal,
      bab: c.bab || null,
      bab_title: c.bab_title || null,
      content: c.content,
      source: c.source,
      embedding: c.embedding,
    }))

    // Insert batch 50 per request supaya tidak timeout
    let inserted = 0
    for (let i = 0; i < chunksToInsert.length; i += 50) {
      const batch = chunksToInsert.slice(i, i + 50)
      const { error } = await supabase.from('pojk_chunks').insert(batch)
      if (error) throw new Error(`Batch ${Math.floor(i/50)+1} gagal: ${error.message}`)
      inserted += batch.length
    }

    console.log(`[embed] ✅ ${inserted} chunks tersimpan untuk pojk_id=${pojk_id}`)
    return res.status(200).json({ success: true, inserted })

  } catch (err) {
    console.error('[embed] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
