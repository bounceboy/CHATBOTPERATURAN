const { createClient } = require('@supabase/supabase-js')

// ── Supabase ──────────────────────────────────────────────
function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  )
}

// ── Scoring keyword ───────────────────────────────────────
function scoreChunk(query, chunk) {
  const tokens = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2)
  const text = (chunk.content + ' ' + chunk.pasal + ' ' + (chunk.bab_title || '')).toLowerCase()
  let score = 0
  for (const t of tokens) {
    if (text.includes(t)) score += 1
    if (chunk.pasal?.toLowerCase().includes(t)) score += 2
  }
  const domainMap = {
    'cdd':              ['cdd','identifikasi','verifikasi','nasabah','hubungan usaha'],
    'edd':              ['edd','enhanced','berisiko tinggi','pep'],
    'dttot':            ['dttot','dppspm','pemblokiran','teroris','blokir'],
    'sanksi':           ['sanksi','denda','pelanggaran'],
    'pelaporan':        ['laporan','ppatk','mencurigakan','tunai','tkm'],
    'pelatihan':        ['pelatihan','sdm','pegawai','kye'],
    'asuransi':         ['asuransi','polis','klaim','beneficiary','penerima manfaat'],
    'pep':              ['pep','politically exposed','pejabat'],
    'beneficial owner': ['beneficial owner','pemilik manfaat'],
    'transfer':         ['transfer','dana','bank pengirim'],
    'fatf':             ['fatf','negara berisiko','countermeasures'],
  }
  const ql = query.toLowerCase()
  for (const [kw, related] of Object.entries(domainMap)) {
    if (ql.includes(kw)) {
      for (const r of related) { if (text.includes(r)) score += 1.5 }
    }
  }
  return score
}

// ── Model routing ─────────────────────────────────────────
function routeModel(query, chunks) {
  let score = chunks.length * 2
  const uniqueSources = new Set(chunks.map(c => c.source))
  score += uniqueSources.size * 5
  const complexKw = ['apakah boleh','apakah melanggar','bandingkan','analisis','implikasi','bagaimana jika','konsekuensi','perbedaan','sanksi','pelanggaran','kewajiban']
  const simpleKw  = ['apa itu','definisi','kepanjangan','singkatan','artinya']
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

// ── Call OpenRouter dengan fallback ───────────────────────
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
          'HTTP-Referer': process.env.APP_URL || 'https://pojk-konsultan.vercel.app',
          'X-Title': 'POJK Konsultan',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          temperature: 0.1,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        }),
      })

      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 1000))
        lastError = new Error(`Rate limit: ${model}`)
        continue
      }
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

// ── Handler utama ─────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { query, messages } = req.body
  if (!query) return res.status(400).json({ error: 'query wajib diisi' })

  try {
    // 1. Retrieve chunks dari Supabase
    const db = getSupabase()
    const { data: allChunks, error } = await db
      .from('pojk_chunks')
      .select('id, pasal, bab, bab_title, source, content')
      .limit(500)

    if (error) throw error

    if (!allChunks || allChunks.length === 0) {
      return res.status(200).json({
        content: 'Database POJK masih kosong. Silakan upload POJK terlebih dahulu melalui admin panel.',
        sources: [], model: null, tier: null,
      })
    }

    // 2. Score dan ambil top chunks
    const scored = allChunks
      .map(c => ({ ...c, score: scoreChunk(query, c) }))
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)

    if (scored.length === 0) {
      return res.status(200).json({
        content: 'Tidak ditemukan pasal yang relevan. Coba gunakan kata kunci yang lebih spesifik.',
        sources: [], model: null, tier: null,
      })
    }

    // 3. Build system prompt
    const context = scored.map(c =>
      `=== ${c.pasal} — ${c.source} (${c.bab || ''}) ===\n${c.content}`
    ).join('\n\n')

    const systemPrompt = `Kamu adalah konsultan regulasi OJK yang ahli dalam peraturan sektor perasuransian dan jasa keuangan Indonesia.

INSTRUKSI:
- Jawab HANYA berdasarkan konteks pasal yang diberikan
- Jangan mengarang informasi di luar konteks
- Selalu sebutkan nomor pasal dan nama POJK sebagai dasar jawaban
- Jika tidak dapat dijawab dari konteks, katakan dengan jelas
- Gunakan Bahasa Indonesia yang formal namun mudah dipahami
- Gunakan poin-poin jika membantu kejelasan

KONTEKS PASAL:
${context}`

    // 4. Route model & call AI
    const tier = routeModel(query, scored)
    const result = await callOpenRouter(tier, messages || [], systemPrompt)

    // 5. Return
    return res.status(200).json({
      content: result.content,
      model: result.model,
      tier: result.tier,
      sources: scored.map(c => ({
        id: c.id,
        pasal: c.pasal,
        bab: c.bab,
        source: c.source,
        preview: (c.content || '').slice(0, 200) + '...',
      })),
    })

  } catch (err) {
    console.error('Chat error:', err)
    return res.status(500).json({ error: 'Terjadi kesalahan server: ' + err.message })
  }
}
