// api/admin-upload.js
// POST /api/admin-upload  { filename, filedata (base64) }
// Upload PDF ke Supabase Storage → ingest lengkap (konsideran + pasal + penjelasan)

import { createClient } from '@supabase/supabase-js'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Auth ──────────────────────────────────────────────────
async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  try {
    const token = authHeader.slice(7)
    const [payloadB64] = token.split('.')
    const payload = JSON.parse(atob(payloadB64))
    if (payload.exp && Date.now() > payload.exp) return null
    if (payload.role !== 'admin') return null
    return payload
  } catch { return null }
}

// ── Parse metadata dari filename ──────────────────────────
function parseFilename(filename) {
  const base = filename.replace(/\.pdf$/i, '').replace(/[_]/g, ' ').trim()
  const match = filename.match(/(?:POJK|OJK)[^\d]*(\d+)[^\d]*(\d{4})/i)
  if (match) {
    return { nomor: `${match[1]}/${match[2]}`, nama: base, tahun: parseInt(match[2]) }
  }
  const matchTahun = filename.match(/(\d{4})/)
  const tahun = matchTahun ? parseInt(matchTahun[1]) : new Date().getFullYear()
  return { nomor: `upload-${Date.now()}`, nama: base, tahun }
}

// ── Split teks jadi 3 segmen ──────────────────────────────
function splitSegments(fullText) {
  const memutuskanM = fullText.match(/\bMEMUTUSKAN\b/)
  const penjelasanM = fullText.match(/\bPENJELASAN\b/)

  const konsideran = memutuskanM
    ? fullText.slice(0, memutuskanM.index).trim()
    : ''

  let batangTubuh, penjelasan
  if (memutuskanM && penjelasanM) {
    batangTubuh = fullText.slice(memutuskanM.index, penjelasanM.index).trim()
    penjelasan  = fullText.slice(penjelasanM.index).trim()
  } else if (memutuskanM) {
    batangTubuh = fullText.slice(memutuskanM.index).trim()
    penjelasan  = ''
  } else {
    batangTubuh = fullText.trim()
    penjelasan  = ''
  }

  return { konsideran, batangTubuh, penjelasan }
}

// ── Chunk konsideran ──────────────────────────────────────
function chunkKonsideran(text, sourceName) {
  if (!text || text.length < 50) return []
  const chunks = []
  const bagianRe = /(Menimbang|Mengingat)\s*:/gi
  const matches = [...text.matchAll(bagianRe)]

  if (!matches.length) {
    return [{ pasal: 'Konsideran', content: text.slice(0, 3000),
              bab: 'Konsideran', bab_title: 'Dasar Hukum & Pertimbangan', source: sourceName }]
  }

  matches.forEach((m, i) => {
    const start = m.index
    const end   = matches[i+1] ? matches[i+1].index : text.length
    const content = text.slice(start, end).trim()
    if (content.length > 20) {
      chunks.push({
        pasal: m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(),
        content: content.slice(0, 3000),
        bab: 'Konsideran', bab_title: 'Dasar Hukum & Pertimbangan', source: sourceName
      })
    }
  })
  return chunks
}

// ── Deteksi BAB ───────────────────────────────────────────
function getBabPositions(text) {
  const re = /\nBAB\s+([IVXLC]+)\s*\n(.*?)(?=\n)/gi
  const result = []
  for (const m of text.matchAll(re)) {
    result.push({ pos: m.index, bab: `BAB ${m[1]}`, title: m[2].trim() })
  }
  return result
}

function babAt(pos, babPositions) {
  let bab = null, title = null
  for (const b of [...babPositions].reverse()) {
    if (b.pos <= pos) { bab = b.bab; title = b.title; break }
  }
  return { bab, bab_title: title }
}

// ── Chunk per pasal ───────────────────────────────────────
function chunkByPasal(text, sourceName, babPrefix = '') {
  const chunks = []
  const babPositions = getBabPositions(text)
  const pasalRe = /(?:^|\n)(Pasal\s+(\d+))\s*\n/gi
  const matches = [...text.matchAll(pasalRe)]
  const seen = new Set()

  matches.forEach((m, i) => {
    const no = parseInt(m[2])
    if (seen.has(no)) return
    seen.add(no)

    const start   = m.index + m[0].length
    const end     = matches[i+1] ? matches[i+1].index : text.length
    const content = text.slice(start, end).trim()
    if (content.length < 15) return

    const { bab, bab_title } = babAt(m.index, babPositions)
    chunks.push({
      pasal    : `${babPrefix}${m[1].trim()}`,
      content  : content.slice(0, 3000),
      bab, bab_title, source: sourceName
    })
  })
  return chunks
}

// ── Main handler ──────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await verifyToken(req.headers.authorization)
  if (!user) return res.status(401).json({ error: 'Unauthorized.' })

  const { filename, filedata } = req.body || {}
  if (!filename || !filedata) return res.status(400).json({ error: 'filename dan filedata wajib.' })

  try {
    const meta      = parseFilename(filename)
    const pdfBuffer = Buffer.from(filedata, 'base64')

    // ── Ekstrak teks dengan pdf-parse ──
    let fullText = ''
    try {
      const parsed = await pdfParse(pdfBuffer)
      fullText = parsed.text || ''
    } catch (e) {
      console.error('pdf-parse error:', e.message)
      return res.status(422).json({ error: 'Gagal membaca PDF. Pastikan file tidak terenkripsi atau rusak.' })
    }

    if (!fullText || fullText.length < 100) {
      return res.status(422).json({ error: 'PDF tidak mengandung teks yang dapat dibaca (kemungkinan scan/gambar).' })
    }

    // ── Upload PDF ke Storage ──
    const storageKey = `pojk/${Date.now()}_${filename.replace(/\s+/g, '_')}`
    const { error: uploadError } = await supabase.storage
      .from('pojk-files')
      .upload(storageKey, pdfBuffer, { contentType: 'application/pdf', upsert: false })

    const fileUrl = uploadError ? null :
      supabase.storage.from('pojk-files').getPublicUrl(storageKey).data?.publicUrl

    // ── Build chunks ──
    const { konsideran, batangTubuh, penjelasan } = splitSegments(fullText)

    const allChunks = [
      ...chunkKonsideran(konsideran, meta.nama),
      ...chunkByPasal(batangTubuh, meta.nama),
      ...chunkByPasal(penjelasan, meta.nama, 'Penjelasan '),
    ]

    const pasalCount = allChunks.filter(c =>
      !c.pasal.startsWith('Penjelasan') && c.bab !== 'Konsideran'
    ).length

    if (!allChunks.length) {
      return res.status(422).json({ error: 'Tidak ada konten yang dapat diproses dari PDF ini.' })
    }

    // ── Insert pojk_list ──
    const { data: pojkRow, error: listErr } = await supabase
      .from('pojk_list')
      .insert({ nomor: meta.nomor, nama: meta.nama, tahun: meta.tahun,
                jumlah_pasal: pasalCount, file_url: fileUrl })
      .select().single()

    if (listErr) throw new Error('Insert pojk_list gagal: ' + listErr.message)

    // ── Insert chunks batch 50 ──
    const chunksWithId = allChunks.map(c => ({ ...c, pojk_id: pojkRow.id }))
    for (let i = 0; i < chunksWithId.length; i += 50) {
      const { error: chunkErr } = await supabase
        .from('pojk_chunks').insert(chunksWithId.slice(i, i + 50))
      if (chunkErr) console.error('Chunk insert error:', chunkErr.message)
    }

    return res.status(200).json({
      success      : true,
      id           : pojkRow.id,
      nama         : meta.nama,
      tahun        : meta.tahun,
      jumlah_pasal : pasalCount,
      total_chunks : allChunks.length,
      file_url     : fileUrl,
    })

  } catch (err) {
    console.error('admin-upload error:', err)
    return res.status(500).json({ error: err.message })
  }
}
