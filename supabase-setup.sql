-- ============================================
-- POJK Konsultan — Supabase Database Setup
-- Jalankan di: Supabase → SQL Editor → Run
-- ============================================

CREATE TABLE IF NOT EXISTS pojk_list (
  id            TEXT PRIMARY KEY,
  nomor         TEXT NOT NULL,
  nama          TEXT NOT NULL,
  tahun         INTEGER,
  jumlah_pasal  INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pojk_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pojk_id     TEXT REFERENCES pojk_list(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  tahun       INTEGER,
  pasal       TEXT NOT NULL,
  bab         TEXT,
  bab_title   TEXT,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_pojk_id ON pojk_chunks(pojk_id);
CREATE INDEX IF NOT EXISTS idx_chunks_pasal   ON pojk_chunks(pasal);

ALTER TABLE pojk_list   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pojk_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read pojk_list"   ON pojk_list   FOR SELECT USING (true);
CREATE POLICY "Public read pojk_chunks" ON pojk_chunks FOR SELECT USING (true);

SELECT 'Setup berhasil! Tabel siap digunakan.' AS status;
