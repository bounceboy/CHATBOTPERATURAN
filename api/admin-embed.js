// api/admin-embed.js
// POST /api/admin-embed  { pojk_id, chunks: [{ pasal, bab, bab_title, content, source }] }
// Embed chunks server-side menggunakan OPENAI_API_KEY, lalu simpan ke pojk_chunks

import { createClient } from '@supabase/supabase-js'

export const config = { maxDuration: 120 }

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

async function embedTexts(texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error('OpenAI embeddings gagal: ' + (err.error?.message || res.status))
  }
  const data = await res.json()
  return data.data.map(d => d.embedding)
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await verifyToken(req)
  if (!user || user.role !== 'admin') return res.status(401).json({ error: 'Unauthorized.' })

  const { pojk_id, chunks } = req.body || {}
  if (!pojk_id || !Array.isArray(chunks) || chunks.length === 0) {
    return res.status(400).json({ error: 'pojk_id dan chunks wajib diisi.' })
  }

  try {
    // Embed server-side dalam batch 20 (batas OpenAI per request)
    const EMBED_BATCH = 20
    const allEmbeddings = []
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH)
      const vecs = await embedTexts(batch.map(c => c.content))
      allEmbeddings.push(...vecs)
    }

    const chunksToInsert = chunks.map((c, i) => ({
      pojk_id,
      pasal: c.pasal,
      bab: c.bab || null,
      bab_title: c.bab_title || null,
      content: c.content,
      source: c.source,
      embedding: allEmbeddings[i],
    }))

    // Insert batch 50
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
