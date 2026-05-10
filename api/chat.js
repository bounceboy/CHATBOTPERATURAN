const { createClient } = require('@supabase/supabase-js')

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

function extractPasalNumbers(query) {
  const matches = query.match(/[Pp]asal\s+(\d+)/g) || []
  return matches.map(m => parseInt(m.replace(/[Pp]asal\s+/, '')))
}

function extractMentionedPojk(messages) {
  // Ekstrak nama POJK yang sudah disebut di conversation history
  const pojkSet = new Set()
  const pojkRe = /POJK\s+(?:No\.?\s+)?(?:Nomor\s+)?(\d+)\s+Tahun\s+(\d{4})/gi
  for (const msg of (messages || [])) {
    const text = typeof msg.content === 'string' ? msg.content : ''
    for (const m of text.matchAll(pojkRe)) {
      pojkSet.add(`POJK No. ${m[1]} Tahun ${m[2]}`)
    }
  }
  return [...pojkSet]
}

function scoreChunk(query, chunk) {
  const ql_raw = query.toLowerCase()
  const tokens = ql_raw.replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2)
  const text = (chunk.content + ' ' + chunk.pasal + ' ' + (chunk.bab_title || '') + ' ' + (chunk.bab || '') + ' ' + (chunk.source || '')).toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (text.includes(t)) score += 1
    if (chunk.pasal?.toLowerCase().includes(t)) score += 3
    if (chunk.source?.toLowerCase().includes(t)) score += 2
  }
  // Bonus untuk exact phrase match (2+ kata berturutan)
  const bigrams = []
  for (let i = 0; i < tokens.length - 1; i++) bigrams.push(tokens[i] + ' ' + tokens[i+1])
  for (const bg of bigrams) { if (text.includes(bg)) score += 4 }
  const domainMap = {
    'cdd':['cdd','identifikasi','verifikasi','nasabah','hubungan usaha'],
    'edd':['edd','enhanced','berisiko tinggi','pep'],
    'dttot':['dttot','dppspm','pemblokiran','teroris','blokir'],
    'sanksi':['sanksi','denda','pelanggaran','administratif'],
    'pelaporan':['laporan','ppatk','mencurigakan','tunai','tkm'],
    'pelatihan':['pelatihan','sdm','pegawai','kye'],
    'asuransi':['asuransi','polis','klaim','beneficiary','penerima manfaat'],
    'pep':['pep','politically exposed','pejabat'],
    'beneficial owner':['beneficial owner','pemilik manfaat'],
    'transfer':['transfer','dana','bank pengirim'],
    'fatf':['fatf','negara berisiko','countermeasures'],
    'konglomerasi':['konglomerasi','jaringan kantor','perusahaan anak'],
    'pengendalian':['pengendalian','intern','internal','audit'],
    'apu':['apu','ppt','pppspm','tppu','tppt'],
    'kebijakan':['kebijakan','prosedur','pedoman','sop'],
    'sinergi':['sinergi','satu kepemilikan','hubungan kepemilikan','pengembangan syariah'],
    'spin off':['spin off','pemisahan','unit syariah','uus','spin-off'],
    'pemisahan':['pemisahan','unit syariah','portofolio kepesertaan','uus','spin off'],
    'syariah':['syariah','tabarru','ujrah','qardh','peserta','kontribusi'],
    'laporan berkala':['laporan berkala','laporan bulanan','laporan triwulanan','laporan tahunan','laporan publikasi'],
    'retensi':['retensi','reasuransi','retrosesi','dukungan reasuransi'],
    'spin-off':['pemisahan','unit syariah','portofolio','kepesertaan'],
    'ekuitas':['ekuitas','modal disetor','modal minimum','permodalan'],
    'izin':['izin usaha','perizinan','kelembagaan','pencabutan izin'],
    'kesehatan':['kesehatan keuangan','tingkat kesehatan','rbc','risk based capital'],
    'produk':['produk asuransi','pemasaran','saluran distribusi','pialang'],
    'laporan keuangan':['laporan keuangan','akuntansi','standar akuntansi','ifrs'],
    'teknologi informasi':['teknologi informasi','ti','sistem informasi','infrastruktur ti','keamanan informasi'],
    'komite pengarah':['komite pengarah','komite ti','komite teknologi','pengawas ti','steering committee'],
    'tata kelola ti':['tata kelola ti','it governance','pengelolaan ti','risiko ti','ljknb'],
    'tata kelola':['tata kelola','gcg','good corporate governance','direksi','dewan komisaris','komisaris'],
    'seojk':['surat edaran','seojk','se ojk','pedoman','panduan'],
    'audit':['audit','internal audit','auditor','pemeriksaan','pengendalian intern'],
    'manajemen risiko':['manajemen risiko','risk management','mitigasi','pengelolaan risiko'],
    'outsourcing':['outsourcing','alih daya','penyedia jasa','vendor','pihak ketiga'],
    'business continuity':['business continuity','bcp','drp','disaster recovery','kelangsungan usaha'],
  }
  const ql = query.toLowerCase()
  for (const [kw, related] of Object.entries(domainMap)) {
    if (ql.includes(kw)) {
      for (const r of related) { if (text.includes(r)) score += 1.5 }
    }
  }
  return score
}

function routeModel(query, chunks, hasFile) {
  // File analysis selalu pakai powerful
  if (hasFile) return 'powerful'

  let score = chunks.length * 2
  const uniqueSources = new Set(chunks.map(c => c.source))
  score += uniqueSources.size * 5
  const complexKw = ['apakah boleh','apakah melanggar','bandingkan','analisis','implikasi','bagaimana jika','konsekuensi','perbedaan','sanksi','pelanggaran','kewajiban']
  const simpleKw  = ['apa itu','definisi','kepanjangan','singkatan','artinya','bunyi','isi pasal']
  const ql = query.toLowerCase()
  if (complexKw.some(k => ql.includes(k))) score += 10
  if (simpleKw.some(k => ql.includes(k)))  score -= 5
  if (query.split(' ').length > 15) score += 3
  if (score <= 4)  return 'fast'
  if (score <= 12) return 'balanced'
  return 'powerful'
}

const FALLBACK_CHAINS = {
  fast:     ['google/gemini-2.0-flash-exp:free', 'meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat'],
  balanced: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4-5'],
  powerful: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o'],
}

async function callOpenRouter(tier, messages, systemPrompt) {
  const chain = FALLBACK_CHAINS[tier]
  const apiKey = process.env.OPENROUTER_API_KEY
  let lastError = null

  for (const model of chain) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.APP_URL || 'https://chatbotperaturan.vercel.app',
          'X-Title': 'CORE - Comprehensive Oversight Regulatory Explorer',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          temperature: 0.1,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      })

      if (res.status === 429) { await new Promise(r => setTimeout(r, 1000)); lastError = new Error(`Rate limit: ${model}`); continue }
      if (!res.ok) { lastError = new Error(`${model} error ${res.status}`); continue }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content
      if (!content) { lastError = new Error(`Respons kosong: ${model}`); continue }

      return { content, model, tier }
    } catch (err) {
      lastError = err
      continue
    }
  }
  throw lastError || new Error('Semua model tidak tersedia')
}

// Build pesan untuk file analysis — support PDF, image, docx (text)
function buildFileMessages(query, file, context) {
  const { name, ext, data, mime } = file

  // PDF dan gambar bisa langsung dikirim sebagai vision
  if (['pdf'].includes(ext)) {
    return [{
      role: 'user',
      content: [
        { type: 'text', text: query },
        { type: 'text', text: `\n\nKONTEKS POJK YANG RELEVAN:\n${context}` },
        { type: 'file', file: { filename: name, file_data: `data:application/pdf;base64,${data}` } },
      ]
    }]
  }

  if (['png','jpg','jpeg','webp'].includes(ext)) {
    return [{
      role: 'user',
      content: [
        { type: 'text', text: query },
        { type: 'text', text: `\n\nKONTEKS POJK YANG RELEVAN:\n${context}` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } },
      ]
    }]
  }

  // Untuk docx — decode base64 dan kirim sebagai teks
  // (docx parsing dilakukan di sisi server)
  return [{
    role: 'user',
    content: `${query}\n\nKONTEKS POJK YANG RELEVAN:\n${context}\n\n[File: ${name} — konten tidak dapat dibaca langsung. Analisis berdasarkan POJK yang tersedia.]`
  }]
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { query, messages, file } = req.body
  if (!query && !file) return res.status(400).json({ error: 'query atau file wajib diisi' })

  const effectiveQuery = query || `Analisis dokumen dan identifikasi ketidaksesuaian dengan POJK`

  try {
    const db = getSupabase()
    const mentionedPasals = extractPasalNumbers(effectiveQuery)
    const mentionedPojk = extractMentionedPojk(messages)
    const limit = file ? 12 : 8
    let chunks = []

    // Gabungkan query dengan pesan terakhir untuk konteks lebih kaya
    const recentContext = (messages || []).slice(-2)
      .map(m => typeof m.content === 'string' ? m.content.slice(0, 300) : '')
      .join(' ')
    const enrichedQuery = effectiveQuery + ' ' + recentContext

    // 1. Pasal eksplisit yang disebut (misal "Pasal 13") — filter by POJK dari history
    if (mentionedPasals.length > 0) {
      const pasalStrings = mentionedPasals.map(n => `Pasal ${n}`)
      let q = db
        .from('pojk_chunks')
        .select('id, pasal, bab, bab_title, source, content')
        .in('pasal', pasalStrings)
      if (mentionedPojk.length > 0 && mentionedPojk.length <= 3) {
        q = q.in('source', mentionedPojk)
      }
      const { data: directChunks } = await q.limit(15)
      if (directChunks?.length > 0) chunks = directChunks
    }

    // 2. Full-Text Search — jauh lebih akurat dari fetch-all scoring
    if (chunks.length < limit) {
      // Bersihkan query untuk tsquery: ambil kata penting, sambung dengan &
      const ftsQuery = enrichedQuery
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .slice(0, 8)  // maks 8 kata
        .join(' | ')  // OR search — lebih toleran

      if (ftsQuery) {
        const { data: ftsChunks } = await db
          .from('pojk_chunks')
          .select('id, pasal, bab, bab_title, source, content')
          .textSearch('fts', ftsQuery, { type: 'plain', config: 'indonesian' })
          .limit(limit * 2)

        // Fallback ke simple config jika indonesian gagal
        let results = ftsChunks
        if (!results || results.length === 0) {
          const { data: fallback } = await db
            .from('pojk_chunks')
            .select('id, pasal, bab, bab_title, source, content')
            .textSearch('fts', ftsQuery, { type: 'plain', config: 'simple' })
            .limit(limit * 2)
          results = fallback
        }

        if (results?.length > 0) {
          // Re-score hasil FTS dengan keyword scoring untuk ranking
          const newChunks = results
            .filter(c => !chunks.find(x => x.id === c.id))
            .map(c => ({ ...c, score: scoreChunk(enrichedQuery, c) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit - chunks.length)
          chunks = [...chunks, ...newChunks]
        }
      }
    }

    // 3. Fallback: fetch-all scoring jika FTS kosong (database lama tanpa kolom fts)
    if (chunks.length === 0) {
      const { data: allChunks } = await db
        .from('pojk_chunks')
        .select('id, pasal, bab, bab_title, source, content')
        .limit(500)
      if (allChunks?.length > 0) {
        chunks = allChunks
          .map(c => ({ ...c, score: scoreChunk(enrichedQuery, c) }))
          .filter(c => c.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
      }
    }

    // Build context string
    // Sanitasi teks agar tidak ada karakter non-ASCII yang merusak ByteString
    function sanitize(s) {
      return (s || '').replace(/[\u0100-\uFFFF]/g, c => {
        // Ganti karakter unicode umum dengan padanannya
        const map = { '\u2014': '-', '\u2013': '-', '\u2018': "'", '\u2019': "'",
                      '\u201C': '"', '\u201D': '"', '\u2026': '...', '\u00A0': ' ' }
        return map[c] || ' '
      })
    }

    const context = chunks.length > 0
      ? chunks.map(c => `=== ${c.pasal} - ${sanitize(c.source)} (${c.bab || ''}) ===\n${sanitize(c.content)}`).join('\n\n')
      : 'Tidak ada pasal yang relevan ditemukan dalam database.'

    // System prompt berbeda untuk file analysis vs chat biasa
    const systemPrompt = file
      ? `Kamu adalah auditor regulasi OJK yang ahli dalam pengawasan sektor perasuransian.

Tugasmu: Analisis dokumen yang diunggah dan identifikasi ketidaksesuaian dengan POJK.

FORMAT OUTPUT yang wajib digunakan:
## Ringkasan Dokumen
[Ringkasan singkat isi dokumen]

## Temuan Ketidaksesuaian
[Jika ada ketidaksesuaian, tampilkan dalam format:]
**[Nomor]. [Judul Temuan]**
- **Kondisi:** [apa yang ada di dokumen]
- **Ketentuan:** [Pasal X POJK Y/Tahun]
- **Gap:** [penjelasan ketidaksesuaian]

## Kesimpulan
[Kesimpulan singkat]

INSTRUKSI:
- Gunakan HANYA pasal-pasal dari konteks POJK yang diberikan
- Jika dokumen sudah sesuai, nyatakan dengan jelas
- Jika tidak dapat membaca isi dokumen, sampaikan dengan jelas`
      : `Kamu adalah konsultan regulasi OJK yang ahli dalam peraturan sektor perasuransian dan jasa keuangan Indonesia.

INSTRUKSI:
- Jawab HANYA berdasarkan konteks pasal yang diberikan di bawah
- DILARANG mengarang, mengasumsikan, atau mengutip pasal yang tidak ada dalam konteks
- Jika user bertanya tentang pasal tertentu (misalnya "Pasal 13"), cari HANYA di konteks yang tersedia
- Jika ada beberapa POJK dengan nomor pasal yang sama, gunakan yang paling relevan dengan topik percakapan
- Selalu sebutkan nomor pasal dan nama POJK lengkap sebagai sumber
- Jika user meminta "bunyi" atau "isi" suatu pasal, KUTIP LANGSUNG teks lengkapnya dari konteks
- Jika pasal yang diminta tidak ada dalam konteks, katakan dengan jelas dan jangan mengarang
- Pertahankan konsistensi dengan jawaban sebelumnya dalam percakapan
- Gunakan Bahasa Indonesia yang formal namun mudah dipahami`

    // Build messages
    let apiMessages
    if (file) {
      apiMessages = buildFileMessages(
        effectiveQuery + `\n\nGunakan konteks POJK berikut untuk analisis:\n${context}`,
        file,
        context
      )
    } else {
      const contextMsg = `KONTEKS PASAL POJK:\n${context}`
      apiMessages = [
        ...(messages || []).slice(-6),
        { role: 'user', content: `${effectiveQuery}\n\n${contextMsg}` }
      ]
    }

    const tier = routeModel(effectiveQuery, chunks, !!file)
    const result = await callOpenRouter(tier, apiMessages, systemPrompt)

    return res.status(200).json({
      content: result.content,
      model: result.model,
      tier: result.tier,
      sources: chunks.map(c => ({
        id: c.id, pasal: c.pasal, bab: c.bab, source: c.source,
        preview: (c.content || '').slice(0, 200) + '...',
      })),
    })

  } catch (err) {
    console.error('Chat error:', err)
    return res.status(500).json({ error: 'Terjadi kesalahan server: ' + err.message })
  }
}
