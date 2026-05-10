#!/usr/bin/env python3
"""
upload_pojk.py — Upload POJK ke database dengan chunking yang lebih baik
Cara pakai:
  python3 upload_pojk.py --file="path/ke/file.pdf" --id="pojk8-2023" --nama="POJK 8/2023" --tahun=2023 --secret=ojk2026 --url=https://chatbotperaturan.vercel.app
"""

import re, json, sys, os, urllib.request, argparse
from pathlib import Path

# ── Parse arguments ───────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument('--file',   required=True)
parser.add_argument('--id',     required=True)
parser.add_argument('--nama',   required=True)
parser.add_argument('--tahun',  default=str(__import__('datetime').datetime.now().year))
parser.add_argument('--secret', required=True)
parser.add_argument('--url',    default='http://localhost:3000')
parser.add_argument('--nomor',  default=None)
args = parser.parse_args()

# ── Read file ─────────────────────────────────────────────
file_path = Path(args.file).expanduser().resolve()
if not file_path.exists():
    print(f"❌ File tidak ditemukan: {file_path}")
    sys.exit(1)

print(f"\n📄 Membaca file: {file_path.name}")
ext = file_path.suffix.lower()

if ext == '.pdf':
    try:
        from pdfminer.high_level import extract_text
        text = extract_text(str(file_path))
    except ImportError:
        print("❌ Install pdfminer: pip install pdfminer.six")
        sys.exit(1)
elif ext == '.txt':
    text = file_path.read_text(encoding='utf-8')
else:
    print(f"❌ Format tidak didukung: {ext}")
    sys.exit(1)

print(f"✅ File dibaca: {len(text):,} karakter")

# ── Parse chunks ──────────────────────────────────────────
print("🔍 Memproses pasal...")

# Clean text
clean = re.sub(r'\f', '\n', text)
clean = re.sub(r' {3,}', ' ', clean)
clean = re.sub(r'\n{3,}', '\n\n', clean)

# Detect BAB
bab_pattern = re.compile(r'BAB ([IVX]+)\s*\n+\s*([A-Z][A-Z\s,/\n]+?)(?=\n\n)', re.MULTILINE)
babs = []
for m in bab_pattern.finditer(clean):
    title = m.group(2).replace('\n', ' ').strip()
    babs.append({'pos': m.start(), 'num': m.group(1), 'title': title})

def get_bab(pos):
    cur = {'num': 'I', 'title': 'KETENTUAN UMUM'}
    for b in babs:
        if b['pos'] <= pos: cur = b
        else: break
    return cur

# Split by pasal headers
pasal_header = re.compile(r'(?:^|\n)\s*(Pasal \d+)\s*\n', re.MULTILINE)
splits = [(m.group(1), m.start()) for m in pasal_header.finditer(clean)]

seen = set()
chunks = []
for i, (pasal_str, start) in enumerate(splits):
    num = int(re.search(r'\d+', pasal_str).group())
    end = splits[i+1][1] if i+1 < len(splits) else len(clean)
    content = clean[start:end].strip()

    if num in seen or len(content) < 60:
        continue
    seen.add(num)

    # Clean up content
    content_clean = re.sub(r'\s*-\s*\d+\s*-\s*', ' ', content)
    content_clean = re.sub(r'\s{3,}', ' ', content_clean).strip()

    bab = get_bab(start)
    chunks.append({
        'pojk_id':   args.id,
        'source':    args.nama,
        'tahun':     int(args.tahun),
        'pasal':     f'Pasal {num}',
        'bab':       f'BAB {bab["num"]}',
        'bab_title': bab['title'],
        'content':   content_clean[:2000],
    })

chunks.sort(key=lambda x: int(re.search(r'\d+', x['pasal']).group()))
print(f"✅ Ditemukan {len(chunks)} pasal")

if len(chunks) == 0:
    print("❌ Tidak ada pasal yang ditemukan. PDF mungkin berupa scan.")
    sys.exit(1)

# ── Upload ────────────────────────────────────────────────
print(f"🚀 Mengupload ke {args.url}/api/ingest ...")

payload = json.dumps({
    'pojkId': args.id,
    'source': args.nama,
    'tahun':  args.tahun,
    'nomor':  args.nomor or args.id,
    'chunks': chunks,   # kirim chunks yang sudah diproses
    'text':   '',       # kosongkan text mentah
}).encode('utf-8')

req = urllib.request.Request(
    f"{args.url}/api/ingest",
    data=payload,
    headers={
        'Content-Type':  'application/json',
        'Authorization': f'Bearer {args.secret}',
    }
)

try:
    res = urllib.request.urlopen(req, timeout=60)
    data = json.loads(res.read())
    print(f"\n✅ Berhasil!")
    print(f"   POJK  : {data.get('source', args.nama)}")
    print(f"   Pasal : {data.get('chunks', len(chunks))} pasal tersimpan")
    print(f"\nRefresh browser untuk melihat perubahan.\n")
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"❌ HTTP Error {e.code}: {body}")
    sys.exit(1)
except Exception as e:
    print(f"❌ Error: {e}")
    sys.exit(1)
