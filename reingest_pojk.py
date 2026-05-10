#!/usr/bin/env python3
"""
reingest_pojk.py — Ingest POJK lengkap ke Supabase
Mencakup: Konsideran, Batang Tubuh (per pasal), dan Penjelasan (per pasal)

Cara pakai:
  pip install pdfplumber supabase
  python3 reingest_pojk.py *.pdf

Env variables:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
"""

import os, sys, re
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    print("Install dulu: pip install pdfplumber"); sys.exit(1)

try:
    from supabase import create_client
except ImportError:
    print("Install dulu: pip install supabase"); sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

def parse_filename(filename):
    base = Path(filename).stem.strip()
    match = re.search(r'(?:POJK|OJK)[^\d]*(\d+)[^\d]*(\d{4})', filename, re.IGNORECASE)
    if match:
        nomor = match.group(1)
        tahun = int(match.group(2))
        return {"nomor": f"{nomor}/{tahun}", "nama": base, "tahun": tahun}
    match_tahun = re.search(r'(\d{4})', filename)
    tahun = int(match_tahun.group(1)) if match_tahun else 2024
    return {"nomor": f"upload-{Path(filename).stem}", "nama": base, "tahun": tahun}

def extract_text(pdf_path):
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            t = page.extract_text()
            if t:
                pages.append(t)
    return "\n".join(pages)

def split_segments(full_text):
    memutuskan_m = re.search(r'\bMEMUTUSKAN\b', full_text)
    penjelasan_m  = re.search(r'\bPENJELASAN\b', full_text)
    konsideran   = full_text[:memutuskan_m.start()].strip() if memutuskan_m else ""
    if memutuskan_m and penjelasan_m:
        batang_tubuh = full_text[memutuskan_m.start():penjelasan_m.start()].strip()
        penjelasan   = full_text[penjelasan_m.start():].strip()
    elif memutuskan_m:
        batang_tubuh = full_text[memutuskan_m.start():].strip()
        penjelasan   = ""
    else:
        batang_tubuh = full_text.strip()
        penjelasan   = ""
    return konsideran, batang_tubuh, penjelasan

def get_bab_positions(text):
    bab_re = re.compile(r'(?:^|\n)BAB\s+([IVXLC]+)\s*\n(.*?)(?=\n)', re.IGNORECASE)
    return [(m.start(), f"BAB {m.group(1)}", m.group(2).strip()) for m in bab_re.finditer(text)]

def bab_at(pos, bab_positions):
    bab, title = None, None
    for bab_pos, b, t in reversed(bab_positions):
        if bab_pos <= pos:
            bab, title = b, t
            break
    return bab, title

def is_amendment_pojk(text):
    """Deteksi apakah POJK ini adalah peraturan perubahan (amandemen)"""
    return bool(re.search(r'PERUBAHAN\s+(?:KEDUA\s+|KETIGA\s+)?ATAS\s+PERATURAN', text, re.IGNORECASE))

def is_seojk(text, filename=""):
    """Deteksi apakah ini Surat Edaran OJK (SEOJK) — tidak punya Pasal, tapi punya BAB Romawi"""
    # Cek dari nama file
    if re.search(r'SEOJK|SURAT.EDARAN', filename, re.IGNORECASE):
        return True
    # Cek dari konten — SEOJK dimulai dengan "Yth." dan tidak punya MEMUTUSKAN
    if text[:100].strip().startswith('Yth.') and not re.search(r'\bMEMUTUSKAN\b', text):
        return True
    # Cek kata kunci di seluruh teks (bukan hanya 500 char pertama)
    return bool(re.search(r'SURAT\s+EDARAN', text[:3000], re.IGNORECASE))

def chunk_by_bab_romawi(text, source_name):
    """Chunk SEOJK berdasarkan BAB Romawi (I., II., III., dst)"""
    chunks = []
    # Pola: angka romawi diikuti titik dan nama bab di awal baris
    bab_re = re.compile(
        r'(?:^|\n)[ \t]*((?:I{1,3}V?|V?I{0,3}|X{0,3})[VX]*(?:I{1,3})?)\. +([A-Z][^\n]{3,60})',
        re.MULTILINE
    )
    matches = list(bab_re.finditer(text))
    for i, m in enumerate(matches):
        roman = m.group(1).strip()
        title = m.group(2).strip()
        start = m.end()
        end   = matches[i+1].start() if i+1 < len(matches) else len(text)
        content = text[start:end].strip()
        if len(content) < 20:
            continue
        # Split content per sub-angka jika panjang
        # Coba pecah per angka (1., 2., 3.) dalam bab
        sub_re = re.compile(r'(?:^|\n)[ \t]*(\d+)\.[ \t]+', re.MULTILINE)
        sub_matches = list(sub_re.finditer(content))
        if len(sub_matches) >= 3 and len(content) > 2000:
            # Ada sub-bagian — chunk per kelompok sub
            for j, sm in enumerate(sub_matches):
                sub_end = sub_matches[j+1].start() if j+1 < len(sub_matches) else len(content)
                sub_content = content[sm.start():sub_end].strip()
                if len(sub_content) > 50:
                    chunks.append({
                        "pasal"    : f"BAB {roman} - Angka {sm.group(1)}",
                        "content"  : sub_content[:3000],
                        "bab"      : f"BAB {roman}",
                        "bab_title": title,
                        "source"   : source_name,
                    })
        else:
            chunks.append({
                "pasal"    : f"BAB {roman}",
                "content"  : content[:3000],
                "bab"      : f"BAB {roman}",
                "bab_title": title,
                "source"   : source_name,
            })
    return chunks

def chunk_by_pasal(text, source_name, bab_prefix=""):
    chunks = []
    bab_positions = get_bab_positions(text)
    seen = set()

    # Deteksi peraturan perubahan — pola pasal berbeda
    is_amendment = is_amendment_pojk(text)

    if is_amendment and not bab_prefix:
        # Mode peraturan perubahan: pasal muncul setelah "berbunyi sebagai berikut:"
        # Pola: "Pasal X" sebagai header tersendiri di tengah teks
        # Tangkap semua "Pasal X" termasuk yang di tengah paragraf penomoran
        pasal_re = re.compile(
            r'(?:^|\n)\s{0,20}(Pasal\s+(\d+[A-Z]?))\s*\n',
            re.IGNORECASE
        )
        matches = list(pasal_re.finditer(text))

        # Filter: hanya pasal yang kontennya substantif (bukan sekedar "Dihapus.")
        for i, m in enumerate(matches):
            no_str = m.group(2).strip().upper()
            if no_str in seen:
                continue
            seen.add(no_str)
            label   = m.group(1).strip()
            start   = m.end()
            # Cari akhir pasal: sampai pasal berikutnya atau angka penomoran baru
            end = matches[i+1].start() if i+1 < len(matches) else len(text)
            content = text[start:end].strip()
            # Skip jika hanya "Dihapus." atau terlalu pendek
            if len(content) < 15:
                continue
            if re.match(r'^Dihapus\.?$', content.strip(), re.IGNORECASE):
                continue
            bab, bab_title = bab_at(m.start(), bab_positions)
            chunks.append({
                "pasal"    : f"{bab_prefix}{label}",
                "content"  : content[:3000],
                "bab"      : bab,
                "bab_title": bab_title,
                "source"   : source_name,
            })
    else:
        # Mode normal: Pasal X di awal baris
        pasal_re = re.compile(r'(?:^|\n)(Pasal\s+(\d+[A-Z]?))\s*\n', re.IGNORECASE)
        matches = list(pasal_re.finditer(text))
        for i, m in enumerate(matches):
            no_str = m.group(2).strip().upper()
            if no_str in seen:
                continue
            seen.add(no_str)
            label   = m.group(1).strip()
            start   = m.end()
            end     = matches[i+1].start() if i+1 < len(matches) else len(text)
            content = text[start:end].strip()
            if len(content) < 15:
                continue
            bab, bab_title = bab_at(m.start(), bab_positions)
            chunks.append({
                "pasal"    : f"{bab_prefix}{label}",
                "content"  : content[:3000],
                "bab"      : bab,
                "bab_title": bab_title,
                "source"   : source_name,
            })
    return chunks

def chunk_konsideran(text, source_name):
    if not text or len(text) < 50:
        return []
    chunks = []
    bagian_re = re.compile(r'(Menimbang|Mengingat)\s*:', re.IGNORECASE)
    matches = list(bagian_re.finditer(text))
    if not matches:
        return [{"pasal": "Konsideran", "content": text[:3000],
                 "bab": None, "bab_title": None, "source": source_name}]
    for i, m in enumerate(matches):
        label   = m.group(1).capitalize()
        start   = m.start()
        end     = matches[i+1].start() if i+1 < len(matches) else len(text)
        content = text[start:end].strip()
        if len(content) > 20:
            chunks.append({"pasal": label, "content": content[:3000],
                           "bab": "Konsideran", "bab_title": "Dasar Hukum & Pertimbangan",
                           "source": source_name})
    return chunks

def ingest_file(pdf_path):
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        print(f"  ✗ File tidak ditemukan: {pdf_path}")
        return False

    print(f"\n📄 {pdf_path.name}")
    meta = parse_filename(pdf_path.name)
    print(f"  Nama  : {meta['nama']}")
    print(f"  Tahun : {meta['tahun']}")

    full_text = extract_text(str(pdf_path))
    if not full_text:
        print("  ✗ Gagal ekstrak teks (PDF scan?)")
        return False
    print(f"  → {len(full_text):,} karakter diekstrak")

    konsideran, batang_tubuh, penjelasan = split_segments(full_text)

    all_chunks = []
    pasal_count = 0
    # Handle SEOJK — struktur berbeda (BAB Romawi, bukan Pasal)
    if is_seojk(full_text, pdf_path.name):
        all_chunks += chunk_konsideran(full_text[:2000], meta['nama'])
        all_chunks += chunk_by_bab_romawi(full_text, meta['nama'])
        pasal_count = len(all_chunks)
        print(f"  → {pasal_count} bab/angka (SEOJK format)")
    else:
        all_chunks += chunk_konsideran(konsideran, meta['nama'])
        all_chunks += chunk_by_pasal(batang_tubuh, meta['nama'])
        all_chunks += chunk_by_pasal(penjelasan, meta['nama'], bab_prefix="Penjelasan ")
        pasal_count = len([c for c in all_chunks
                           if not c['pasal'].startswith('Penjelasan')
                           and c['bab'] != 'Konsideran'])
        print(f"  → {pasal_count} pasal | {len([c for c in all_chunks if c['pasal'].startswith('Penjelasan')])} penjelasan | {len([c for c in all_chunks if c['bab']=='Konsideran'])} konsideran")

    if not all_chunks:
        print("  ✗ Tidak ada chunk")
        return False

    # Hapus data lama
    resp = supabase.table("pojk_list").select("id").eq("nama", meta['nama']).execute()
    for row in (resp.data or []):
        pid = row["id"]
        supabase.table("pojk_chunks").delete().eq("pojk_id", pid).execute()
        supabase.table("pojk_list").delete().eq("id", pid).execute()
        print(f"  → Hapus data lama: {pid}")

    # Insert pojk_list
    resp = supabase.table("pojk_list").insert({
        "nomor"       : meta['nomor'],
        "nama"        : meta['nama'],
        "tahun"       : meta['tahun'],
        "jumlah_pasal": pasal_count,
        "file_url"    : None,
    }).execute()

    if not resp.data:
        print(f"  ✗ Gagal insert pojk_list")
        return False

    pojk_id = resp.data[0]["id"]

    # Insert chunks batch 50
    chunks_with_id = [{**c, "pojk_id": pojk_id} for c in all_chunks]
    for i in range(0, len(chunks_with_id), 50):
        supabase.table("pojk_chunks").insert(chunks_with_id[i:i+50]).execute()

    print(f"  ✓ Selesai — total {len(all_chunks)} chunks diingest")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Cara pakai: python3 reingest_pojk.py file.pdf [file2.pdf ...]")
        sys.exit(1)
    files = sys.argv[1:]
    success, failed = 0, 0
    for f in files:
        if ingest_file(f):
            success += 1
        else:
            failed += 1
    print(f"\n{'='*40}")
    print(f"Selesai: {success} berhasil, {failed} gagal")
