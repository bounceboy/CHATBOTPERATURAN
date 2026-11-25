// api/admin-embed.js
// POST /api/admin-embed  { pojk_id, chunks: [{ pasal, bab, bab_title, content, source }] }
// Embed chunks server-side menggunakan OPENAI_API_KEY, lalu simpan ke pojk_chunks

import { createClient } from '@supabase/supabase-js'
import { verifyAdmin } from './_verify.js'

export const config = { maxDuration: 120 }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

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

  if (!verifyAdmin(req.headers.authorization)) {
    return res.status(401).json({ error: 'Sesi tidak valid. Silakan login ulang.' })
  }

  const { pojk_id, chunks } = req.body || {}
  if (!pojk_id || !Array.isArray(chunks) || chunks.length === 0) {
    return res.status(400).json({ error: 'pojk_id dan chunks wajib diisi.' })
  }

  const { data: pojk, error: pojkErr } = await supabase
    .from('pojk_list').select('nama, sektor, status, jenis_dokumen').eq('id', pojk_id).single()
  if (pojkErr || !pojk?.sektor) return res.status(400).json({ error: 'Peraturan tidak ditemukan atau sektor belum diisi.' })

  const { count: chunkAwal, error: countErr } = await supabase
    .from('pojk_chunks').select('id', { count: 'exact', head: true }).eq('pojk_id', pojk_id)
  if (countErr || chunkAwal > 0) return res.status(409).json({ error: 'Peraturan ini sudah memiliki chunk.' })

  try {
    // Versi lama dengan nama sama: pertahankan kategorinya, hapus setelah versi baru tersimpan
    const { data: lama } = await supabase
      .from('pojk_list').select('id').eq('nama', pojk.nama).neq('id', pojk_id)
    const idLama = (lama || []).map(x => x.id)
    let kategori = ['dapen', 'penjaminan'].includes(pojk.sektor) ? pojk.sektor : 'keduanya'
    if (kategori === 'keduanya' && idLama.length > 0) {
      const { data: contoh } = await supabase
        .from('pojk_chunks').select('kategori').in('pojk_id', idLama).limit(1)
      if (['syariah', 'konvensional'].includes(contoh?.[0]?.kategori)) kategori = contoh[0].kategori
    }

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
      sektor: pojk.sektor,
      status: pojk.status,
      jenis_dokumen: pojk.jenis_dokumen,
      kategori,
    }))

    // Insert batch 50
    let inserted = 0
    for (let i = 0; i < chunksToInsert.length; i += 50) {
      const batch = chunksToInsert.slice(i, i + 50)
      const { error } = await supabase.from('pojk_chunks').insert(batch)
      if (error) throw new Error(`Batch ${Math.floor(i/50)+1} gagal: ${error.message}`)
      inserted += batch.length
    }

    if (idLama.length > 0) {
      const { error } = await supabase.from('pojk_list').delete().in('id', idLama) // chunk ikut terhapus (cascade)
      if (error) console.error('[embed] Gagal menghapus versi lama:', error.message)
    }

    console.log(`[embed] ✅ ${inserted} chunks tersimpan untuk pojk_id=${pojk_id}`)
    return res.status(200).json({ success: true, inserted })

  } catch (err) {
    console.error('[embed] Error:', err.message)
    await supabase.from('pojk_list').delete().eq('id', pojk_id) // batalkan versi baru yang tidak lengkap
    return res.status(500).json({ error: err.message })
  }
}
