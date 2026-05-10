const fs = require('fs')
const path = require('path')

const args = {}
process.argv.slice(2).forEach(arg => {
  const [key, ...rest] = arg.replace('--','').split('=')
  args[key] = rest.join('=')
})

if (!args.file || !args.id || !args.nama) {
  console.error('Cara pakai: node upload-pojk.js --file=FILE.pdf --id=xxx --nama="xxx" --tahun=2023 --secret=xxx --url=https://xxx')
  process.exit(1)
}

async function main() {
  const filePath = path.resolve(args.file)
  if (!fs.existsSync(filePath)) { console.error('❌ File tidak ditemukan:', filePath); process.exit(1) }
  console.log('\n📄 Membaca file:', args.file)

  let text = ''
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    const pdfParseModule = require('pdf-parse')
    const pdfParse = typeof pdfParseModule === 'function' ? pdfParseModule : pdfParseModule.default
    const buf = fs.readFileSync(filePath)
    const result = await pdfParse(buf)
    text = result.text
    console.log(`✅ PDF dibaca: ${text.length.toLocaleString()} karakter, ${result.numpages} halaman`)
  } else if (ext === '.txt') {
    text = fs.readFileSync(filePath, 'utf8')
    console.log(`✅ TXT dibaca: ${text.length.toLocaleString()} karakter`)
  } else {
    console.error('❌ Format tidak didukung. Gunakan .pdf atau .txt'); process.exit(1)
  }

  if (text.length < 100) { console.error('❌ Teks terlalu pendek.'); process.exit(1) }

  const baseUrl = args.url || 'http://localhost:3000'
  const secret = args.secret || process.env.INGEST_SECRET
  if (!secret) { console.error('❌ --secret belum diisi'); process.exit(1) }

  console.log(`🚀 Mengupload ke ${baseUrl}/api/ingest ...`)

  const res = await fetch(`${baseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
    body: JSON.stringify({ text, pojkId: args.id, source: args.nama, tahun: args.tahun || String(new Date().getFullYear()), nomor: args.nomor || args.id }),
  })

  const data = await res.json()
  if (!res.ok) { console.error('❌ Gagal upload:', data.error); process.exit(1) }

  console.log(`\n✅ Berhasil!`)
  console.log(`   POJK  : ${data.source}`)
  console.log(`   Pasal : ${data.chunks} pasal tersimpan\n`)
}

main().catch(err => { console.error('Error:', err.message); process.exit(1) })
