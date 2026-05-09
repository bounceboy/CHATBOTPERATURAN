// api/admin-upload.js
// POST /api/admin-upload  { filename, filedata (base64) }
// Upload PDF ke Supabase Storage → ingest pasal ke pojk_chunks

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null
  try {
    const token = authHeader.slice(7)
    const [payloadB64] = token.split('.')
    const payload = JSON.parse(atob(payloadB64))
    if (payload.exp && Date.now() > payload.exp) return null
    if (payload.role !== 'admin') return null
    return payload
  } catch {
    return null
  }
}

// Parse nama POJK dari filename
// Contoh: POJK_8_2023_APU_PPT.pdf → { nomor: '8/2023', nama: 'POJK 8/2023 APU PPT', tahun: 2023 }
function parseFilename(filename) {
  const base = filename.replace(/\.pdf$/i, '').replace(/_/g, ' ')

  // Coba ekstrak nomor dan tahun dari pola POJK_X_YYYY atau POJK X/YYYY
  const match = filename.match(/pojk[_\s-]*(\d+)[_\s/.-]*(\d{4})/i)
  if (match) {
    const nomor = match[1]
    const tahun = parseInt(match[2])
    const namaClean = base.replace(/pojk/i, 'POJK').trim()
    return { nomor: `${nomor}/${tahun}`, nama: namaClean, tahun }
  }

  return { nomor: null, nama: base, tahun: new Date().getFullYear() }
}

// Ekstrak teks dari PDF menggunakan fetch ke Supabase Storage URL
// Karena tidak ada pdf-parse di Vercel serverless, kita simpan dulu
// lalu gunakan pendekatan sederhana: simpan sebagai file + catat metadata
// Untuk ingest pasal, delegasikan ke script terpisah atau lakukan text extraction minimal

async function extractTextFromBase64(base64Data) {
  // Konversi base64 ke buffer
  const binaryStr = atob(base64Data)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }

  // Basic PDF text extraction — cari stream text objects
  const text = new TextDecoder('latin1').decode(bytes)

  // Extract text antara BT dan ET markers (PDF text objects)
  const chunks = []
  const btEtRegex = /BT\s*([\s\S]*?)\s*ET/g
  let match
  while ((match = btEtRegex.exec(text)) !== null) {
    const block = match[1]
    // Extract string literals: (text) atau <hex>
    const strRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)|<([0-9A-Fa-f]+)>/g
    let strMatch
    let blockText = ''
    while ((strMatch = strRegex.exec(block)) !== null) {
      if (strMatch[1] !== undefined) {
        // Literal string — unescape basic PDF escapes
        blockText += strMatch[1]
          .replace(/\\n/g, '\n').replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
          .replace(/\\([()\\])/g, '$1')
          + ' '
      } else if (strMatch[2]) {
        // Hex string
        const hex = strMatch[2]
        let hexStr = ''
        for (let i = 0; i < hex.length; i += 2) {
          hexStr += String.fromCharCode(parseInt(hex.substr(i, 2), 16))
        }
        blockText += hexStr + ' '
      }
    }
    if (blockText.trim().length > 2) chunks.push(blockText.trim())
  }

  return chunks.join('\n').replace(/\s+/g, ' ').trim()
}

// Coba split teks menjadi pasal-pasal
function splitIntoPasal(fullText) {
  const results = []

  // Pattern pasal: "Pasal 1", "Pasal 12", dll
  const pasalPattern = /Pasal\s+(\d+)\s*([\s\S]*?)(?=Pasal\s+\d+|$)/gi
  let match

  while ((match = pasalPattern.exec(fullText)) !== null) {
    const noPasal = match[1]
    const content = match[2].trim()
    if (content.length > 20) {
      results.push({
        pasal: `Pasal ${noPasal}`,
        content: content.substring(0, 2000), // limit per chunk
        bab: null,
        bab_title: null,
      })
    }
  }

  // Kalau tidak ketemu pola pasal, buat chunks per 500 karakter
  if (results.length === 0 && fullText.length > 0) {
    const chunkSize = 500
    for (let i = 0; i < fullText.length; i += chunkSize) {
      const chunk = fullText.slice(i, i + chunkSize).trim()
      if (chunk.length > 50) {
        results.push({
          pasal: `Bagian ${Math.floor(i/chunkSize) + 1}`,
          content: chunk,
          bab: null,
          bab_title: null,
        })
      }
    }
  }

  return results
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const user = await verifyToken(req.headers.authorization)
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized. Login sebagai admin.' })
  }

  const { filename, filedata } = req.body || {}

  if (!filename || !filedata) {
    return res.status(400).json({ error: 'filename dan filedata wajib diisi.' })
  }

  try {
    // 1. Parse metadata dari filename
    const meta = parseFilename(filename)

    // 2. Upload PDF ke Supabase Storage
    const storageKey = `pojk/${Date.now()}_${filename.replace(/\s+/g,'_')}`
    const pdfBuffer = Buffer.from(filedata, 'base64')

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('pojk-files')
      .upload(storageKey, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: false,
      })

    if (uploadError) throw new Error('Upload storage gagal: ' + uploadError.message)

    // 3. Dapatkan public URL
    const { data: urlData } = supabase.storage
      .from('pojk-files')
      .getPublicUrl(storageKey)
    const fileUrl = urlData?.publicUrl || null

    // 4. Ekstrak teks & split per pasal
    const fullText = await extractTextFromBase64(filedata)
    const pasalList = splitIntoPasal(fullText)

    // 5. Insert ke pojk_list
    const { data: pojkRow, error: insertListErr } = await supabase
      .from('pojk_list')
      .insert({
        nomor: meta.nomor,
        nama: meta.nama,
        tahun: meta.tahun,
        jumlah_pasal: pasalList.length,
        file_url: fileUrl,
      })
      .select()
      .single()

    if (insertListErr) throw new Error('Insert pojk_list gagal: ' + insertListErr.message)

    // 6. Insert chunks ke pojk_chunks
    if (pasalList.length > 0) {
      const chunksToInsert = pasalList.map(p => ({
        pojk_id: pojkRow.id,
        pasal: p.pasal,
        bab: p.bab,
        bab_title: p.bab_title,
        content: p.content,
        source: meta.nama,
      }))

      // Insert in batches of 50
      for (let i = 0; i < chunksToInsert.length; i += 50) {
        const batch = chunksToInsert.slice(i, i + 50)
        const { error: chunkErr } = await supabase
          .from('pojk_chunks')
          .insert(batch)
        if (chunkErr) console.error('Chunk insert error:', chunkErr.message)
      }
    }

    return res.status(200).json({
      success: true,
      id: pojkRow.id,
      nama: meta.nama,
      tahun: meta.tahun,
      jumlah_pasal: pasalList.length,
      file_url: fileUrl,
    })

  } catch (err) {
    console.error('admin-upload error:', err)
    return res.status(500).json({ error: err.message })
  }
}
