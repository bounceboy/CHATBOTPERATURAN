const { createClient } = require('@supabase/supabase-js')

function getSupabaseAdmin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
}

function parseToChunks(text, { pojkId, source, tahun }) {
  let clean = text.replace(/\f/g, '\n').replace(/ {3,}/g, ' ').replace(/\n{3,}/g, '\n\n')

  const babPattern = /BAB ([IVX]+)\s*\n+\s*([A-Z][A-Z\s,/\n]+?)(?=\n\n)/gm
  const babs = []
  let m
  while ((m = babPattern.exec(clean)) !== null) {
    babs.push({ pos: m.index, num: m[1], title: m[2].replace(/\n/g, ' ').trim() })
  }

  const getBab = (pos) => {
    let cur = { num: 'I', title: 'KETENTUAN UMUM' }
    for (const b of babs) { if (b.pos <= pos) cur = b; else break }
    return cur
  }

  const pasalHeader = /(?:^|\n)\s*(Pasal \d+)\s*\n/gm
  const splits = []
  while ((m = pasalHeader.exec(clean)) !== null) {
    splits.push({ pasal: m[1], pos: m.index })
  }

  const seen = new Set()
  const chunks = []

  for (let i = 0; i < splits.length; i++) {
    const { pasal, pos } = splits[i]
    const num = parseInt(pasal.replace('Pasal ', ''))
    const end = i + 1 < splits.length ? splits[i + 1].pos : clean.length
    let content = clean.slice(pos, end).trim()
    if (seen.has(num) || content.length < 60) continue
    seen.add(num)
    content = content.replace(/\s*-\s*\d+\s*-\s*/g, ' ').replace(/\s{3,}/g, ' ').trim()
    const bab = getBab(pos)
    chunks.push({
      pojk_id: pojkId, source, tahun: parseInt(tahun) || new Date().getFullYear(),
      pasal: `Pasal ${num}`, bab: `BAB ${bab.num}`, bab_title: bab.title,
      content: content.slice(0, 2000),
    })
  }

  return chunks.sort((a, b) => parseInt(a.pasal.replace('Pasal ', '')) - parseInt(b.pasal.replace('Pasal ', '')))
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (req.headers.authorization !== `Bearer ${process.env.INGEST_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })

  const { text, chunks: preChunks, pojkId, source, tahun, nomor } = req.body
  if (!pojkId || !source) return res.status(400).json({ error: 'pojkId dan source wajib diisi' })

  try {
    const db = getSupabaseAdmin()
    let chunks

    if (preChunks && preChunks.length > 0) {
      chunks = preChunks.map(c => ({
        pojk_id: pojkId, source, tahun: parseInt(tahun) || new Date().getFullYear(),
        pasal: c.pasal, bab: c.bab, bab_title: c.bab_title, content: c.content,
      }))
    } else if (text) {
      chunks = parseToChunks(text, { pojkId, source, tahun })
    } else {
      return res.status(400).json({ error: 'Kirim chunks atau text' })
    }

    if (chunks.length === 0) return res.status(400).json({ error: 'Tidak ada pasal yang berhasil diproses' })

    await db.from('pojk_list').upsert({ id: pojkId, nomor: nomor || pojkId, nama: source, tahun: parseInt(tahun) || new Date().getFullYear(), jumlah_pasal: 0 })
    await db.from('pojk_chunks').delete().eq('pojk_id', pojkId)
    const { error } = await db.from('pojk_chunks').insert(chunks)
    if (error) throw error
    await db.from('pojk_list').update({ jumlah_pasal: chunks.length }).eq('id', pojkId)

    return res.status(200).json({ success: true, pojkId, source, chunks: chunks.length, message: `Berhasil mengingesti ${chunks.length} pasal dari ${source}` })
  } catch (err) {
    console.error('Ingest error:', err)
    return res.status(500).json({ error: err.message })
  }
}
