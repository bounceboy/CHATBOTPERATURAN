const { createClient } = require('@supabase/supabase-js')
const https = require('https')

// Embed query menggunakan OpenAI text-embedding-3-small
async function embedQuery(text) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY tidak diset')

  const body = JSON.stringify({
    input: text.slice(0, 8000),
    model: 'text-embedding-3-small',
  })

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.error) reject(new Error(json.error.message))
          else resolve(json.data[0].embedding)
        } catch(e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
}

function extractPasalNumbers(query) {
  const matches = query.match(/[Pp]asal\s+(\d+)/g) || []
  return matches.map(m => parseInt(m.replace(/[Pp]asal\s+/, '')))
}

function extractMentionedPojk(messages) {
  // Ekstrak nama POJK yang sudah disebut di conversation history
  // Support berbagai format penulisan POJK
  const pojkSet = new Set()
  const patterns = [
    /POJK\s+(?:No\.?\s+)?(?:Nomor\s+)?(\d+)\s+Tahun\s+(\d{4})/gi,
    /Peraturan\s+OJK\s+(?:No(?:mor)?\.?\s+)?(\d+)[\s/]+(\d{4})/gi,
    /POJK\s+(\d+)[\s/]+(\d{4})/gi,
    /No\.?\s+(\d+)\s+Tahun\s+(\d{4})/gi,
  ]
  for (const msg of (messages || [])) {
    const text = typeof msg.content === 'string' ? msg.content : ''
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        pojkSet.add(`POJK No. ${m[1]} Tahun ${m[2]}`)
      }
    }
  }
  return [...pojkSet]
}

// Normalisasi query: ubah kata berimbuhan ke bentuk dasar
// Solusi untuk FTS 'simple' yang tidak support stemming bahasa Indonesia
function normalizeQuery(q) {
  const stemMap = {
    'keterlambatan': 'terlambat',
    'keterlambatan': 'terlambat',
    'pelanggaran': 'langgar',
    'penyampaian': 'sampaikan',
    'penerapan': 'terapkan',
    'pengendalian': 'kendali',
    'pelaksanaan': 'laksana',
    'pemberian': 'berikan',
    'pemisahan': 'pisah',
    'pemenuhan': 'penuhi',
    'pengawasan': 'awasi',
    'penggunaan': 'gunakan',
    'pengelolaan': 'kelola',
    'pemanfaatan': 'manfaat',
    'pencegahan': 'cegah',
    'pencucian': 'cuci',
    'pendanaan': 'dana',
    'perasuransian': 'asuransi',
    'perasuransian': 'asuransi',
    'reasuransian': 'reasuransi',
    'kesehatan': 'sehat',
    'keuangan': 'keuangan',
    'permodalan': 'modal',
    'perizinan': 'izin',
    'kepatuhan': 'patuh',
    'pendirian': 'dirikan',
    'pembubaran': 'bubar',
    'perubahan': 'ubah',
    'kepemilikan': 'milik',
    'pengkinian': 'kini',
    'pemblokiran': 'blokir',
  }
  let result = q.toLowerCase()
  for (const [from, to] of Object.entries(stemMap)) {
    result = result.replace(new RegExp(from, 'gi'), to)
  }
  return result
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
  // Jika ada POJK yang disebut di history tapi tidak di query saat ini,
  // tambahkan ke effectiveQuery supaya vector search tidak kehilangan konteks
  const mentionedPojkEarly = extractMentionedPojk(messages)
  const pojkInCurrentQuery = effectiveQuery.match(/(?:POJK|SEOJK)\s*(?:No\.?\s*)?(\d+)\s+(?:Tahun\s+)?(\d{4})/i)
  // Deteksi topic shift: cek apakah ada overlap antara query baru dan POJK di history
  // Kalau tidak ada overlap, anggap user ganti topik — jangan inject POJK lama
  const isTopicContinued = mentionedPojkEarly.length > 0 && (() => {
    const qLower = effectiveQuery.toLowerCase()
    // Ambil kata kunci dari POJK history (nomor, tahun, nama)
    const pojkKeywords = mentionedPojkEarly.flatMap(p => {
      const m = p.match(/(\d+).*?(\d{4})/)
      return m ? [m[1], m[2]] : []
    })
    // Cek apakah query menyebut nomor/tahun POJK yang sama, atau topik yang sama dari recent AI response
    const recentAiContent = (messages || []).filter(m => m.role === 'assistant').slice(-1)
      .map(m => typeof m.content === 'string' ? m.content.toLowerCase().slice(0, 500) : '').join(' ')
    const queryWords = qLower.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3)
    const overlap = queryWords.filter(w => recentAiContent.includes(w))
    return pojkKeywords.some(k => qLower.includes(k)) || overlap.length >= 2
  })()
  const enrichedEffectiveQuery = (!pojkInCurrentQuery && isTopicContinued)
    ? effectiveQuery + ' ' + mentionedPojkEarly.slice(0,2).join(' ')
    : effectiveQuery

  try {
    const db = getSupabase()
    const mentionedPasals = extractPasalNumbers(effectiveQuery)
    const mentionedPojk = extractMentionedPojk(messages)
    const limit = file ? 12 : 10
    let chunks = []

    // enrichedQuery HANYA untuk scoring, TIDAK untuk FTS search
    // Ini mencegah kata-kata dari history meracuni retrieval
    const recentContext = (messages || []).slice(-2)
      .map(m => typeof m.content === 'string' ? m.content.slice(0, 200) : '')
      .join(' ')
    const enrichedQuery = effectiveQuery + ' ' + recentContext
    // searchQuery HANYA dari query user saat ini — untuk FTS
    // Dinormalisasi untuk mengatasi keterbatasan FTS simple (tidak ada stemming)
    const searchQuery = normalizeQuery(effectiveQuery)

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

    // 1.5 Vector similarity search — primary retrieval method
    try {
      const queryEmbedding = await embedQuery(enrichedEffectiveQuery)

      // Deteksi apakah user menyebut POJK spesifik di query
      // Support: "POJK 72/2016", "POJK 72 Tahun 2016", "POJK 72" (tanpa tahun - lookup dari history)
      const pojkInQuery = effectiveQuery.match(/(?:POJK|SEOJK)\s*(?:No\.?\s*)?(\d+)[\/\s]+(?:POJK\.\d+\/)?(?:Tahun\s+)?(\d{4})/i)
        || effectiveQuery.match(/(?:POJK|SEOJK)\s*(?:No\.?\s*)?(\d+)(?!\d)/i)

      let filterSource = null
      if (pojkInQuery) {
        const num = pojkInQuery[1]
        const year = pojkInQuery[2]
        if (year) {
          filterSource = `POJK No. ${num} Tahun ${year}`
        } else {
          // Cari tahun dari mentionedPojk history
          const matched = mentionedPojk.find(p => p.includes(`No. ${num} Tahun`) || p.includes(`No. ${num}/`))
          filterSource = matched || null
        }
      } else if (mentionedPojk.length === 1) {
        filterSource = mentionedPojk[0]
      }

      // Search dengan filter source jika ada POJK spesifik
      const { data: v1, error: e1 } = await db.rpc('match_pojk_chunks', {
        query_embedding: queryEmbedding,
        match_count: limit,
        filter_source: filterSource,
      })

      let vectorChunks = (!e1 && v1?.length > 0) ? v1 : []

      // Jika dengan filter kurang, tambah search global
      if (vectorChunks.length < limit) {
        const { data: v2, error: e2 } = await db.rpc('match_pojk_chunks', {
          query_embedding: queryEmbedding,
          match_count: limit,
          filter_source: null,
        })
        if (!e2 && v2?.length > 0) {
          const existIds = new Set(vectorChunks.map(c => c.id))
          const global = v2.filter(c => !existIds.has(c.id))
          vectorChunks = [...vectorChunks, ...global].slice(0, limit)
        }
      }

      if (vectorChunks.length > 0) {
        const existIds = new Set(chunks.map(c => c.id))
        chunks = [...chunks, ...vectorChunks.filter(c => !existIds.has(c.id))]
      }
    } catch(embErr) {
      console.error('Embedding error:', embErr.message)
    }

    // 1.6 Sanksi query expansion — jika query menyebut kewajiban/pelanggaran,
    // otomatis cari pasal sanksi yang relevan dari POJK yang sama
    const isSanksiQuery = /sanksi|denda|pelanggaran|hukuman|dikenakan|administratif|pidana/i.test(effectiveQuery)
    const isKewajibanQuery = /wajib|kewajiban|harus|dilarang|persyaratan|ekuitas|modal|laporan/i.test(effectiveQuery)

    if ((isSanksiQuery || isKewajibanQuery) && chunks.length > 0) {
      try {
        // Ambil source POJK dari chunks yang sudah ditemukan
        const activeSources = [...new Set(chunks.map(c => c.source))]

        // Buat query untuk cari pasal sanksi
        const sanksiQuery = isSanksiQuery
          ? effectiveQuery  // query sudah menyebut sanksi, pakai langsung
          : `sanksi administratif pelanggaran ${effectiveQuery.slice(0, 100)}`

        const sanksiEmbedding = await embedQuery(sanksiQuery)

        // Cari pasal sanksi di POJK yang sama
        for (const source of activeSources.slice(0, 2)) {
          const { data: sanksiChunks } = await db.rpc('match_pojk_chunks', {
            query_embedding: sanksiEmbedding,
            match_count: 3,
            filter_source: source,
          })
          if (sanksiChunks?.length > 0) {
            const existIds = new Set(chunks.map(c => c.id))
            const newSanksi = sanksiChunks.filter(c =>
              !existIds.has(c.id) &&
              /sanksi|denda|pelanggaran|administratif/i.test(c.content)
            )
            chunks = [...chunks, ...newSanksi]
          }
        }
      } catch(sanksiErr) {
        console.error('Sanksi expansion error:', sanksiErr.message)
      }
    }

    // 1.7 Cross-POJK reference retrieval
    // Jika chunk yang ditemukan mereferensikan POJK lain, ambil chunk dari POJK tersebut
    if (chunks.length > 0) {
      try {
        const allContent = chunks.map(c => c.content).join(' ')
        // Deteksi referensi ke POJK lain dalam konten chunk
        const crossRefs = [...allContent.matchAll(/(?:POJK|Peraturan Otoritas Jasa Keuangan)\s+(?:Nomor\s+|No\.?\s+)?(\d+)(?:\/POJK\.\d+)?\/(\d{4})|POJK\s+(?:No\.?\s+)?(\d+)\s+Tahun\s+(\d{4})/gi)]
        const referencedSources = new Set()
        for (const m of crossRefs) {
          const num = m[1] || m[3]
          const year = m[2] || m[4]
          if (num && year) {
            referencedSources.add(`POJK No. ${num} Tahun ${year}`)
          }
        }
        // Hapus source yang sudah ada di chunks
        const existingSources = new Set(chunks.map(c => c.source))
        const newSources = [...referencedSources].filter(s => !existingSources.has(s))

        // Ambil chunk dari POJK yang direferensikan (max 2 POJK, 3 chunk per POJK)
        for (const refSource of newSources.slice(0, 2)) {
          const refEmbedding = await embedQuery(`${effectiveQuery} ${refSource}`)
          const { data: refChunks } = await db.rpc('match_pojk_chunks', {
            query_embedding: refEmbedding,
            match_count: 3,
            filter_source: refSource,
          })
          if (refChunks?.length > 0) {
            const existIds = new Set(chunks.map(c => c.id))
            chunks = [...chunks, ...refChunks.filter(c => !existIds.has(c.id))]
          }
        }
      } catch(crossErr) {
        console.error('Cross-POJK retrieval error:', crossErr.message)
      }
    }

    // 2. Full-Text Search — jauh lebih akurat dari fetch-all scoring
    if (chunks.length < limit) {
      // Bersihkan query untuk tsquery: ambil kata penting, sambung dengan &
      // Deteksi pertanyaan tentang daftar/list — ambil dari semua POJK
      // isListQuery: hanya untuk pertanyaan tentang daftar/inventori POJK
      // "berapa denda" bukan list query — harus masuk FTS
      const isListQuery = /daftar|list|apa saja|semua|seluruh|database|miliki|punya/i.test(enrichedQuery)
        || (/berapa/i.test(enrichedQuery) && /pojk|peraturan|regulasi/i.test(enrichedQuery))

      if (isListQuery) {
        // Ambil 1 chunk representatif per POJK
        const { data: pojkList } = await db
          .from('pojk_list')
          .select('id, nama, tahun')
          .order('tahun', { ascending: false })

        if (pojkList?.length > 0) {
          for (const pojk of pojkList.slice(0, 20)) {
            const { data: sample } = await db
              .from('pojk_chunks')
              .select('id, pasal, bab, bab_title, source, content')
              .eq('pojk_id', pojk.id)
              .limit(1)
            if (sample?.[0]) chunks.push(sample[0])
          }
        }
      } else {
        // FTS: gunakan searchQuery (HANYA query user), bukan enrichedQuery
        // Strategi AND-first: presisi tinggi → fallback bertahap
        const stopWords = new Set(['yang','dan','atau','dalam','pada','untuk','dari','dengan','ini','itu','adalah','oleh','juga','ada','tidak','sudah','akan','dapat','harus','atas','tentang','serta','bahwa','suatu','setiap','antara','apakah','bagaimana','apa','berapa','kapan','siapa','dimana','kenapa','mengapa','jelaskan','sebutkan','mengatur','terkait','mengenai','berikan','pasal','pojk','seojk','nomor','tahun','bunyi','coba','tolong'])
        // Preserve akronim penting (apu, ppt, cdd, edd, dll) dengan min length 2
        // Ganti tanda hubung dengan spasi agar "apu-ppt" → "apu ppt"
        const ftsWords = searchQuery
          .toLowerCase()
          .replace(/-/g, ' ')
          .replace(/[^a-z0-9 ]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2 && !stopWords.has(w))
          .slice(0, 6)

        // Ekspansi akronim domain — tambah sinonim yang kemungkinan ada di database
        const domainExpand = {
          'apu': ['pencucian','uang','apu'],
          'ppt': ['pendanaan','terorisme','ppt'],
          'cdd': ['identifikasi','nasabah','cdd'],
          'edd': ['enhanced','berisiko','edd'],
          'tppu': ['pencucian','uang','tppu'],
          'tppt': ['pendanaan','terorisme','tppt'],
          'rbc': ['risk','based','capital','rbc'],
          'gcg': ['tata','kelola','gcg'],
          'uus': ['unit','syariah','uus'],
          'dps': ['dewan','pengawas','syariah'],
        }
        const expandedWords = [...ftsWords]
        for (const w of ftsWords) {
          if (domainExpand[w]) {
            for (const syn of domainExpand[w]) {
              if (!expandedWords.includes(syn)) expandedWords.push(syn)
            }
          }
        }
        // Gunakan expanded words untuk FTS jika ada ekspansi, tapi tetap batasi
        const ftsWordsExpanded = expandedWords.slice(0, 8)

        let results = []

        if (ftsWords.length > 0) {
          // Helper: build query dengan optional filter POJK dari context history
          // Helper: jalankan FTS menggunakan to_tsquery langsung via RPC
          // Ini lebih reliable daripada Supabase textSearch() yang perilakunya beda
          const runFts = async (tsquery, pojkFilter, lim) => {
            // Gunakan .rpc() untuk panggil fungsi SQL langsung
            // Fallback ke textSearch jika RPC tidak tersedia
            try {
              let q = db.from('pojk_chunks')
                .select('id, pasal, bab, bab_title, source, content')
                .filter('fts', 'fts', tsquery)
              if (pojkFilter && pojkFilter.length > 0 && pojkFilter.length <= 3) {
                q = q.in('source', pojkFilter)
              }
              const { data } = await q.limit(lim)
              return data || []
            } catch {
              return []
            }
          }

          // Bangun AND tsquery: "denda & terlambat & laporan"
          const toTsquery = (words) => words.join(' ')  // plain type: spasi = AND (plainto_tsquery)
          // Bangun OR tsquery: "denda | terlambat"
          const toOrQuery = (words) => words.join(' | ')

          // Tahap 1: AND query (semua kata wajib ada) — cari di POJK dari history dulu
          const andWords = ftsWords.length <= 2 && ftsWordsExpanded.length > ftsWords.length
            ? ftsWordsExpanded.slice(0, 4)
            : ftsWords
          const tsAnd = toTsquery(andWords)

          // Gunakan textSearch dengan plain type + & operator
          const buildQ = (tsq, pojkFilter, lim) => {
            let q = db.from('pojk_chunks')
              .select('id, pasal, bab, bab_title, source, content')
              .textSearch('fts', tsq, { type: 'plain', config: 'simple' })
            if (pojkFilter && pojkFilter.length > 0 && pojkFilter.length <= 3) {
              q = q.in('source', pojkFilter)
            }
            return q.limit(lim)
          }

          const { data: r1 } = await buildQ(tsAnd, mentionedPojk, 20)
          results = r1 || []

          // Tahap 1b — tidak pakai filter POJK (mentionedPojk) untuk FTS
          // Filter POJK hanya untuk query pasal eksplisit (Step 1 di atas)
          // Biarkan scoring yang menentukan relevansi POJK
          if (results.length === 0) {
            const { data: r1b } = await buildQ(tsAnd, null, 20)
            results = r1b || []
          }

          // Tahap 2: 3 kata paling penting jika AND penuh masih kurang
          if (results.length < 3 && ftsWords.length > 3) {
            const ts3 = toTsquery(ftsWords.slice(0, 3))
            const { data: r2 } = await buildQ(ts3, null, 20)
            if (r2?.length > 0) {
              const existIds = new Set(results.map(x => x.id))
              results = [...results, ...r2.filter(x => !existIds.has(x.id))]
            }
          }

          // Tahap 3: OR jika benar-benar kosong
          if (results.length === 0) {
            const commonWords = new Set(['laporan','pasal','ketentuan','peraturan','perusahaan','asuransi','pihak','tahun','nomor'])
            const specificWords = ftsWords.filter(w => !commonWords.has(w))
            const wordsToOr = specificWords.length > 0 ? specificWords : ftsWords.slice(0, 2)
            if (wordsToOr.length > 0) {
              const tsOr = toOrQuery(wordsToOr)
              const { data: r3 } = await buildQ(tsOr, null, 15)
              if (r3?.length > 0) results = r3
            }
          }
        }

        if (results.length > 0) {
          // Scoring menggunakan enrichedQuery (inkl. konteks history) — tapi pool sudah bersih dari AND
          const newChunks = results
            .filter(c => !chunks.find(x => x.id === c.id))
            .map(c => ({ ...c, score: scoreChunk(enrichedQuery, c) }))
            .filter(c => c.score > 0) // threshold minimal
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

INSTRUKSI WAJIB — DILARANG DILANGGAR:
1. Jawab HANYA berdasarkan teks dari konteks pasal yang diberikan. TIDAK BOLEH menggunakan pengetahuan di luar konteks.
2. DILARANG KERAS menyebut nomor angka (Rp, %, hari, dsb) yang tidak muncul verbatim di konteks. Jika angkanya tidak ada di konteks, jangan sebut.
3. DILARANG menyebut "Pasal X ayat (Y)" jika isi pasal/ayat tersebut tidak ada dalam konteks. Cek dulu sebelum menyebut.
4. Jika konteks yang diberikan tidak mengandung jawaban atas pertanyaan user, jawab: "Informasi tentang [topik] tidak ditemukan dalam database POJK yang tersedia. Silakan merujuk langsung ke teks peraturan resmi."
5. Selalu cantumkan sumber tepat: nama POJK lengkap dan nomor pasal dari konteks.
6. Jika user meminta "bunyi" atau "isi" pasal, KUTIP LANGSUNG dari konteks — jangan parafrase.
7. Pertahankan konsistensi dengan jawaban sebelumnya dalam percakapan.
8. Gunakan Bahasa Indonesia yang formal namun mudah dipahami.`

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
