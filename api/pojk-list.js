const { createClient } = require('@supabase/supabase-js')

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method !== 'GET') return res.status(405).end()

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const { data, error } = await db
    .from('pojk_list')
    .select('id, nomor, nama, tahun, jumlah_pasal, file_url')
    .order('tahun', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ pojk: data || [] })
}
