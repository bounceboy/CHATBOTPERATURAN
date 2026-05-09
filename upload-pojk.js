#!/usr/bin/env node
/**
 * upload-pojk.js — Script untuk mengupload PDF POJK ke database
 *
 * Cara pakai (dari Terminal/Command Prompt di folder project):
 *
 * # Upload ke lokal (testing):
 * node upload-pojk.js --file="POJK_8_2023.pdf" --id="pojk8-2023" --nama="POJK 8/2023 APU-PPT-PPPSPM" --tahun=2023 --secret=password-kamu
 *
 * # Upload ke Vercel (produksi):
 * node upload-pojk.js --file="POJK_8_2023.pdf" --id="pojk8-2023" --nama="POJK 8/2023 APU-PPT-PPPSPM" --tahun=2023 --secret=password-kamu --url=https://pojk-konsultan.vercel.app
 *
 * Install dependency dulu (sekali saja):
 *   npm install pdf-parse
 */

const fs   = require('fs')
const path = require('path')

const args = {}
process.argv.slice(2).forEach(arg => {
  const [key, ...rest] = arg.replace('--', '').split('=')
  args[key] = rest.join('=')
})

if (!args.file || !args.id || !args.nama) {
  console.error('\nCara pakai:')
  console.error('  node upload-pojk.js --file=FILE.pdf --id=pojk8-2023 --nama="POJK 8/2023" --tahun=2023 --secret=xxx\n')
  process.exit(1)
}

async function main() {
  const fetch = globalThis.fetch || (await import('node-fetch').then(m => m.default).catch(() => {
    console.error('Install node-fetch: npm install node-fetch')
    process.exit(1)
  }))

  const filePath = path.resolve(args.file)
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File tidak ditemukan: ${filePath}`)
    process.exit(1)
  }

  console.log(`\n📄 Membaca file: ${args.file}`)

  let text = ''
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.pdf') {
    let pdfParse
    try { pdfParse = require('pdf-parse') } catch {
      console.error('❌ Install pdf-parse dulu: npm install pdf-parse')
      process.exit(1)
    }
    const buf = fs.readFileSync(filePath)
    const result = await pdfParse(buf)
    text = result.text
    console.log(`✅ PDF dibaca: ${text.length.toLocaleString()} karakter, ${result.numpages} halaman`)
  } else if (ext === '.txt') {
    text = fs.readFileSync(filePath, 'utf8')
    console.log(`✅ TXT dibaca: ${text.length.toLocaleString()} karakter`)
  } else {
    console.error('❌ Format tidak didukung. Gunakan .pdf atau .txt')
    process.exit(1)
  }

  if (text.length < 100) {
    console.error('❌ Teks terlalu pendek. PDF mungkin berupa scan — coba konversi ke TXT.')
    process.exit(1)
  }

  const baseUrl = args.url || 'http://localhost:3000'
  const secret  = args.secret || process.env.INGEST_SECRET

  if (!secret) {
    console.error('❌ --secret belum diisi. Contoh: --secret=ojk-ingest-2025')
    process.exit(1)
  }

  console.log(`🚀 Mengupload ke ${baseUrl}/api/ingest ...`)

  const res = await fetch(`${baseUrl}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify({
      text,
      pojkId: args.id,
      source: args.nama,
      tahun: args.tahun || String(new Date().getFullYear()),
      nomor: args.nomor || args.id,
    }),
  })

  const data = await res.json()

  if (!res.ok) {
    console.error('❌ Gagal upload:', data.error)
    process.exit(1)
  }

  console.log(`\n✅ Berhasil!`)
  console.log(`   POJK  : ${data.source}`)
  console.log(`   ID    : ${data.pojkId}`)
  console.log(`   Pasal : ${data.chunks} pasal tersimpan`)
  console.log(`\nRefresh browser untuk melihat POJK baru di sidebar.\n`)
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
