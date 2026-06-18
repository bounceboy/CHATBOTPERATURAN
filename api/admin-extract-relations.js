const { createClient } = require('@supabase/supabase-js')
const OpenAI = require('openai')

module.exports.config = { maxDuration: 300 }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).end()

  const { source } = req.body
  if (!source) return res.status(400).json({ error: 'source wajib diisi' })

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  // Hapus relasi lama untuk source ini
  await sb.from('pojk_relations').delete().eq('from_source', source)

  const { data: chunks, error } = await sb
    .from('pojk_chunks')
    .select('id, source, pasal, content')
    .eq('source', source)
    .not('content', 'ilike', '%Cukup jelas%')
    .order('pasal')

  if (error || !chunks?.length) {
    return res.status(404).json({ error: 'Tidak ada chunks ditemukan untuk source ini' })
  }

  // Deduplikasi per pasal
  const byPasal = new Map()
  for (const chunk of chunks) {
    if (!byPasal.has(chunk.pasal)) {
      byPasal.set(chunk.pasal, { ...chunk })
    } else {
      byPasal.get(chunk.pasal).content += '\n' + chunk.content
    }
  }

  const norm = s => s ? s.replace(/\s+/g, ' ').trim() : s
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  let totalInserted = 0

  for (const chunk of byPasal.values()) {
    const prompt = `Kamu menganalisis teks pasal dari peraturan OJK Indonesia.

Ekstrak SEMUA cross-reference dalam teks berikut. Cross-reference adalah referensi ke pasal atau ayat lain.

Konteks chunk ini:
- POJK: ${chunk.source}
- Pasal: ${chunk.pasal}

Teks:
${chunk.content}

Kembalikan JSON array. Setiap item berisi:
{
  "from_ayat": string|null,
  "to_source": string,
  "to_pasal": string,
  "to_ayat": string|null,
  "relation": string,
  "kutipan": string
}

Aturan:
- relation: "mengacu_ke" | "sanksi_untuk" | "diubah_oleh" | "dicabut_oleh" | "mensyaratkan"
- "sebagaimana dimaksud pada ayat (X)" tanpa menyebut pasal → to_pasal = "${chunk.pasal}"
- "sebagaimana dimaksud dalam Pasal X" → to_pasal = "Pasal X"
- Jika referensi ke POJK lain, tuliskan nama lengkap POJK-nya sebagai to_source
- Jika tidak ada cross-reference, kembalikan []
- JANGAN include referensi ke Peraturan Pemerintah, Undang-Undang, atau non-POJK/SEOJK

Hanya kembalikan JSON array, tanpa penjelasan.`

    let relations = []
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: 'Kamu adalah parser regulasi hukum Indonesia. Selalu kembalikan hanya JSON array.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1000,
      })
      const raw = response.choices[0].message.content?.trim() || ''
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      const parsed = JSON.parse(cleaned)
      relations = Array.isArray(parsed) ? parsed : (Object.values(parsed).find(v => Array.isArray(v)) || [])
    } catch {
      await sleep(650)
      continue
    }

    if (relations.length) {
      const rows = relations
        .filter(r => r.to_pasal && r.relation)
        .map(r => ({
          from_source: chunk.source,
          from_pasal: norm(chunk.pasal),
          from_ayat: r.from_ayat || null,
          to_source: r.to_source || chunk.source,
          to_pasal: norm(r.to_pasal),
          to_ayat: r.to_ayat || null,
          relation: r.relation,
          keterangan: r.kutipan || null,
          confidence: 0.9,
        }))

      if (rows.length) {
        const { error: upsErr } = await sb.from('pojk_relations').upsert(rows, {
          onConflict: 'from_source,from_pasal,from_ayat,to_source,to_pasal,to_ayat,relation',
          ignoreDuplicates: true,
        })
        if (!upsErr) totalInserted += rows.length
      }
    }

    await sleep(650)
  }

  return res.status(200).json({
    success: true,
    source,
    pasal_diproses: byPasal.size,
    relasi_ditemukan: totalInserted,
  })
}
