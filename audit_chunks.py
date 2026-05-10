#!/usr/bin/env python3
"""
audit_chunks.py — Audit kualitas chunk semua POJK di database
Cek: jumlah chunk, batang tubuh, penjelasan, embedding coverage

Cara pakai:
  python3 audit_chunks.py

Env variables:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
"""

import os, sys

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

def audit():
    print("🔍 Mengambil semua chunk dari database...")
    
    # Ambil semua chunk
    resp = supabase.table('pojk_chunks') \
        .select('id, pasal, source, content, embedding') \
        .execute()
    
    chunks = resp.data or []
    print(f"📊 Total chunk: {len(chunks)}\n")
    
    # Group by source
    by_source = {}
    for c in chunks:
        src = c['source'] or 'Unknown'
        if src not in by_source:
            by_source[src] = []
        by_source[src].append(c)
    
    # Analisis per POJK
    print(f"{'POJK':<30} {'Total':>6} {'Batang':>7} {'Penjls':>7} {'Embed':>6} {'Status'}")
    print("-" * 75)
    
    issues = []
    
    for source in sorted(by_source.keys()):
        chunks_list = by_source[source]
        total = len(chunks_list)
        
        batang = len([c for c in chunks_list 
                      if not c['pasal'].startswith('Penjelasan') 
                      and c['pasal'] not in ('Menimbang', 'Mengingat', 'Konsideran')])
        
        penjelasan = len([c for c in chunks_list 
                         if c['pasal'].startswith('Penjelasan')])
        
        embedded = len([c for c in chunks_list if c['embedding'] is not None])
        
        # Deteksi masalah
        status_flags = []
        
        if batang == 0:
            status_flags.append("❌ NO_BATANG")
            issues.append((source, "Batang tubuh kosong — perlu reingest"))
        elif batang < 5:
            status_flags.append("⚠️ TIPIS")
            issues.append((source, f"Batang tubuh hanya {batang} chunk — mungkin perlu reingest"))
        
        if embedded < total:
            missing = total - embedded
            status_flags.append(f"⚠️ EMBED-{missing}")
            issues.append((source, f"{missing} chunk belum ter-embed"))
        
        # Cek ada chunk dengan content sangat pendek
        short = len([c for c in chunks_list if len(c.get('content','')) < 50])
        if short > 0:
            status_flags.append(f"⚠️ SHORT-{short}")
        
        status = ' '.join(status_flags) if status_flags else "✅ OK"
        
        src_short = source[:29] if len(source) > 29 else source
        print(f"{src_short:<30} {total:>6} {batang:>7} {penjelasan:>7} {embedded:>6} {status}")
    
    # Summary
    print("\n" + "=" * 75)
    print(f"📋 RINGKASAN MASALAH ({len(issues)} issues):")
    print()
    
    if not issues:
        print("✅ Semua POJK dalam kondisi baik!")
    else:
        seen = set()
        for source, issue in issues:
            key = f"{source}:{issue}"
            if key not in seen:
                seen.add(key)
                print(f"  • {source}: {issue}")
    
    print()
    print("💡 REKOMENDASI:")
    
    no_batang = [s for s, i in issues if 'Batang tubuh kosong' in i]
    tipis = [s for s, i in issues if 'hanya' in i]
    no_embed = [s for s, i in issues if 'embed' in i]
    
    if no_batang:
        print(f"  1. Reingest ulang: {', '.join(no_batang)}")
    if tipis:
        print(f"  2. Periksa manual: {', '.join(tipis)}")
    if no_embed:
        print(f"  3. Jalankan embed_chunks.py untuk: {len(no_embed)} POJK")

if __name__ == "__main__":
    audit()
