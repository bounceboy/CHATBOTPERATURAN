// api/admin-upload.js
// POST /api/admin-upload  { filename, filedata (base64) }
// Tahap 1: Upload PDF → Ekstrak teks → Chunking → Return chunks ke browser
// Embedding dilakukan di browser, lalu simpan via admin-embed.js

import { createClient } from '@supabase/supabase-js'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ─── Auth ─────────────────────────────────────────────────────────────────────

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

// ─── Parse metadata dari filename ─────────────────────────────────────────────

function parseFilename(filename) {
  const tahunDefault = new Date().getFullYear()

  const matchPojk = filename.match(/pojk[_\s./No.-]*(\d+)[_\s./TahunNo.-]*(\d{4})/i)
  if (matchPojk) {
    const nomor = matchPojk[1]
    const tahun = parseInt(matchPojk[2])
    return { nomor: `${nomor}/${tahun}`, nama: `POJK No. ${nomor} Tahun ${tahun}`, tahun }
  }

  const matchSeojk = filename.match(/seojk[_\s./No.-]*(\d+)[_\s./TahunNo.-]*(\d{4})/i)
  if (matchSeojk) {
    const nomor = matchSeojk[1]
    const tahun = parseInt(matchSeojk[2])
    return { nomor: `SE-${nomor}/${tahun}`, nama: `SEOJK No. ${nomor} Tahun ${tahun}`, tahun }
  }

  const matchTahun = filename.match(/(\d{4})/)
  const tahun = matchTahun ? parseInt(matchTahun[1]) : tahunDefault
  const base = filename.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').trim()
  return { nomor: `upload-${Date.now()}`, nama: base || filename.replace(/\.pdf$/i, ''), tahun }
}

// ─── Ekstrak judul dari teks ───────────────────────────────────────────────────

function extractTitle(text) {
  const match = text.match(/TENTANG\s+([\s\S]{10,300}?)(?:\n\s*\n|\bDENGAN\b|\bMENIMBANG\b)/i)
  if (match) {
    return match[1].replace(/\s+/g, ' ').replace(/[^\w\s,.()/]/g, '').trim().substring(0, 200)
  }
  return null
}

// ─── Chunking teks per pasal ───────────────────────────────────────────────────

function chunkText(fullText, sourceName, title) {
  const chunks = []
  const titlePrefix = title ? `[${sourceName} — ${title}]\n` : `[${sourceName}]\n`

  // Deteksi posisi BAB
  const babMap = {}
  const babPattern = /\n(BAB\s+[IVXLCDM]+)\s*\n([^\n]+)/gi
  let babMatch
  while ((babMatch = babPattern.exec(fullText)) !== null) {
    babMap[babMatch.index] = { bab: babMatch[1].trim(), bab_title: babMatch[2].trim() }
  }

  const sections = fullText.split(/(?=\nPasal\s+\d+\b)/gi)
  let currentBab = null
  let currentBabTitle = null
  let pos = 0

  for (const section of sections) {
    for (const [babPos, babInfo] of Object.entries(babMap)) {
      if (parseInt(babPos) <= pos) {
        currentBab = babInfo.bab
        currentBabTitle = babInfo.bab_title
      }
    }

    const pasalMatch = section.match(/^[\s\n]*(Pasal\s+\d+)\b/i)
    const pasal = pasalMatch ? pasalMatch[1].trim() : null
    const content = section.trim()

    if (content.length < 30) { pos += section.length; continue }

    if (content.length > 1800) {
      const subChunkSize = 1500
      const overlap = 200
      for (let i = 0; i < content.length; i += subChunkSize - overlap) {
        const sub = content.slice(i, i + subChunkSize).trim()
        if (sub.length < 30) continue
        chunks.push({ pasal: pasal || `Bagian ${chunks.length + 1}`, bab: currentBab, bab_title: currentBabTitle, content: titlePrefix + sub })
      }
    } else {
      chunks.push({ pasal: pasal || `Bagian ${chunks.length + 1}`, bab: currentBab, bab_title: currentBabTitle, content: titlePrefix + content })
    }
    pos += section.length
  }

  // Fallback kalau tidak ada pasal
  if (chunks.length === 0 && fullText.trim().length > 0) {
    for (let i = 0; i < fullText.length; i += 850) {
      const sub = fullText.slice(i, i + 1000).trim()
      if (sub.length < 50) continue
      chunks.push({ pasal: `Bagian ${Math.floor(i / 850) + 1}`, bab: null, bab_title: null, content: titlePrefix + sub })
    }
  }

  return chunks
}

// ─── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const user = await verifyToken(req.headers.authorization)
  if (!user) return res.status(401).json({ error: 'Unauthorized. Login sebagai admin.' })

  const { filename, filedata } = req.body || {}
  if (!filename || !filedata) return res.status(400).json({ error: 'filename dan filedata wajib diisi.' })

  try {
    const pdfBuffer = Buffer.from(filedata, 'base64')
    const meta = parseFilename(filename)
    console.log(`[upload] Memproses: ${meta.nama}`)

    // Upload PDF ke Supabase Storage
    const storageKey = `pojk/${Date.now()}_${filename.replace(/\s+/g, '_')}`
    const { error: uploadError } = await supabase.storage
      .from('pojk-files')
      .upload(storageKey, pdfBuffer, { contentType: 'application/pdf', upsert: false })
    if (uploadError) throw new Error('Upload storage gagal: ' + uploadError.message)

    const { data: urlData } = supabase.storage.from('pojk-files').getPublicUrl(storageKey)
    const fileUrl = urlData?.publicUrl || null

    // Ekstrak teks dari PDF
    const parsed = await pdfParse(pdfBuffer)
    const fullText = parsed.text || ''
    if (fullText.trim().length < 100) {
      throw new Error('Teks PDF tidak berhasil diekstrak. Pastikan PDF bukan hasil scan (image-based).')
    }

    // Chunking
    const title = extractTitle(fullText)
    const chunks = chunkText(fullText, meta.nama, title)
    if (chunks.length === 0) throw new Error('Tidak ada chunk yang berhasil dibuat dari PDF ini.')

    // Hapus POJK lama kalau ada (reingest)
    const { data: existing } = await supabase
      .from('pojk_list').select('id').eq('nomor', meta.nomor).maybeSingle()
    if (existing) {
      await supabase.from('pojk_chunks').delete().eq('pojk_id', existing.id)
      await supabase.from('pojk_list').delete().eq('id', existing.id)
    }

    // Insert ke pojk_list
    const { data: pojkRow, error: insertListErr } = await supabase
      .from('pojk_list')
      .insert({ nomor: meta.nomor, nama: meta.nama, tahun: meta.tahun, jumlah_pasal: chunks.length, file_url: fileUrl })
      .select().single()
    if (insertListErr) throw new Error('Insert pojk_list gagal: ' + insertListErr.message)

    console.log(`[upload] ✅ ${meta.nama} — ${chunks.length} chunks siap di-embed`)

    // Return chunks ke browser untuk proses embedding di client
    return res.status(200).json({
      success: true,
      pojk_id: pojkRow.id,
      nama: meta.nama,
      tahun: meta.tahun,
      judul: title,
      file_url: fileUrl,
      chunks: chunks.map(c => ({
        pasal: c.pasal,
        bab: c.bab,
        bab_title: c.bab_title,
        content: c.content,
        source: meta.nama,
      })),
    })

  } catch (err) {
    console.error('[upload] Error:', err.message)
    return res.status(500).json({ error: err.message })
  }
}
