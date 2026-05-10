#!/usr/bin/env python3
"""
embed_chunks.py — Embed semua pojk_chunks ke OpenAI text-embedding-3-small
Lalu simpan ke kolom embedding di Supabase

Cara pakai:
  pip install openai supabase python-dotenv
  python3 embed_chunks.py

Env variables:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  OPENAI_API_KEY
"""

import os, sys, time
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    print("Install dulu: pip install openai"); sys.exit(1)

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
OPENAI_KEY   = os.environ.get("OPENAI_API_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Set SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY")
    sys.exit(1)

if not OPENAI_KEY:
    print("ERROR: Set OPENAI_API_KEY")
    sys.exit(1)

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
client   = OpenAI(api_key=OPENAI_KEY)

EMBED_MODEL  = "text-embedding-3-small"
BATCH_SIZE   = 50   # embed 50 chunk sekaligus
RATE_LIMIT   = 0.5  # detik antar batch

def get_embedding(texts: list[str]) -> list[list[float]]:
    """Embed batch of texts, return list of vectors"""
    response = client.embeddings.create(
        input=texts,
        model=EMBED_MODEL,
    )
    return [item.embedding for item in response.data]

def embed_text_for_chunk(chunk: dict) -> str:
    """Gabungkan field chunk jadi satu string untuk di-embed"""
    parts = []
    if chunk.get('source'):
        parts.append(chunk['source'])
    if chunk.get('pasal'):
        parts.append(chunk['pasal'])
    if chunk.get('bab_title'):
        parts.append(chunk['bab_title'])
    if chunk.get('content'):
        parts.append(chunk['content'][:1000])  # max 1000 char
    return ' | '.join(parts)

def main():
    print("🔍 Mengambil chunks yang belum di-embed...")
    
    # Ambil semua chunk yang belum punya embedding
    resp = supabase.table('pojk_chunks') \
        .select('id, pasal, bab_title, source, content') \
        .is_('embedding', 'null') \
        .execute()
    
    chunks = resp.data or []
    total = len(chunks)
    
    if total == 0:
        print("✅ Semua chunk sudah di-embed!")
        return
    
    print(f"📊 Total chunk yang perlu di-embed: {total}")
    print(f"💰 Estimasi biaya: ~${total * 500 / 1_000_000 * 0.02:.4f} USD")
    print()
    
    # Process dalam batch
    success = 0
    failed  = 0
    
    for i in range(0, total, BATCH_SIZE):
        batch = chunks[i:i+BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
        
        print(f"  Batch {batch_num}/{total_batches} ({len(batch)} chunks)...", end=' ')
        
        try:
            # Buat teks untuk di-embed
            texts = [embed_text_for_chunk(c) for c in batch]
            
            # Embed
            embeddings = get_embedding(texts)
            
            # Update ke Supabase satu per satu
            for chunk, embedding in zip(batch, embeddings):
                supabase.table('pojk_chunks') \
                    .update({'embedding': embedding}) \
                    .eq('id', chunk['id']) \
                    .execute()
            
            success += len(batch)
            print(f"✓ ({success}/{total})")
            
        except Exception as e:
            failed += len(batch)
            print(f"✗ Error: {e}")
        
        # Rate limiting
        if i + BATCH_SIZE < total:
            time.sleep(RATE_LIMIT)
    
    print()
    print(f"{'='*40}")
    print(f"✅ Selesai: {success} berhasil, {failed} gagal")
    
    if success > 0:
        print()
        print("📌 Langkah selanjutnya — jalankan SQL ini di Supabase:")
        print("""
CREATE INDEX IF NOT EXISTS pojk_chunks_embedding_idx 
ON pojk_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
        """)

if __name__ == "__main__":
    main()
