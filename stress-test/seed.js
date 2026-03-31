/**
 * Seed Script — isi tabel transactions dengan data dummy untuk stress test
 *
 * Usage:
 *   node seed.js           → insert 990 baris dummy (default)
 *   node seed.js --count=500
 *   node seed.js --clean   → hapus semua baris dengan reference_id diawali "SEED-"
 *
 * Wajib: file .env di root project dengan SUPABASE_URL dan SUPABASE_KEY
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const BATCH_SIZE = 100; // Supabase insert per batch
const PREFIX     = 'SEED-';

// ── Parse args ────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const isClean = args.includes('--clean');
const countArg = args.find(a => a.startsWith('--count='));
const TARGET  = countArg ? parseInt(countArg.split('=')[1], 10) : 990;

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildRow(i) {
  const pad  = String(i).padStart(6, '0');
  const categories = ['BIG - MAN 2K', 'BIG - WOMAN 2K', 'CHILD - BOY 2K', 'CHILD - GIRL 2K'];
  const kategori   = categories[i % categories.length];
  const amount     = kategori.includes('CHILD') ? 100000 : 115000;

  return {
    reference_id:     `${PREFIX}${pad}`,
    amount,
    status:           'pending',
    buyer_name:       `Seed User ${pad}`,
    buyer_phone:      `0899${pad}`,
    buyer_email:      `seed${pad}@test.com`,
    jenis_kelamin:    i % 2 === 0 ? 'Laki-Laki' : 'Perempuan',
    tanggal_lahir:    '2000-01-01',
    kontak_darurat:   '08000000000',
    alamat:           'Jl. Seed Test No. ' + i,
    kategori_lari:    kategori,
    ukuran_kaos:      ['S', 'M', 'L', 'XL'][i % 4],
    golongan_darah:   ['A', 'B', 'AB', 'O'][i % 4],
    riwayat_penyakit: 'Tidak Ada',
    surat_pernyataan: 'Setuju',
  };
}

// ── Clean mode ────────────────────────────────────────────────────────────────
async function clean() {
  console.log(`Menghapus semua baris dengan reference_id LIKE '${PREFIX}%'...`);

  const { error, count } = await supabase
    .from('transactions')
    .delete({ count: 'exact' })
    .like('reference_id', `${PREFIX}%`);

  if (error) {
    console.error('Gagal menghapus:', error.message);
    process.exit(1);
  }

  console.log(`Berhasil menghapus ${count ?? '?'} baris.`);
}

// ── Seed mode ─────────────────────────────────────────────────────────────────
async function seed() {
  // Cek berapa baris seed yang sudah ada
  const { count: existing } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true })
    .like('reference_id', `${PREFIX}%`);

  const alreadySeeded = existing || 0;
  const toInsert      = Math.max(0, TARGET - alreadySeeded);

  console.log(`Target: ${TARGET} baris | Sudah ada: ${alreadySeeded} | Akan insert: ${toInsert}`);

  if (toInsert === 0) {
    console.log('Tidak perlu insert, sudah cukup.');
    return;
  }

  let inserted = 0;
  const startIndex = alreadySeeded;

  for (let i = startIndex; i < startIndex + toInsert; i += BATCH_SIZE) {
    const batch = [];
    for (let j = i; j < Math.min(i + BATCH_SIZE, startIndex + toInsert); j++) {
      batch.push(buildRow(j));
    }

    const { error } = await supabase.from('transactions').insert(batch);

    if (error) {
      console.error(`Batch ${i}–${i + batch.length} gagal:`, error.message);
      process.exit(1);
    }

    inserted += batch.length;
    process.stdout.write(`\rProgress: ${inserted}/${toInsert} baris...`);
  }

  console.log(`\nSelesai. Total inserted: ${inserted} baris.`);

  // Tampilkan total tabel sekarang
  const { count: total } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true });

  console.log(`Total seluruh transaksi di DB: ${total}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Error: SUPABASE_URL dan SUPABASE_KEY harus diset di .env');
    process.exit(1);
  }

  if (isClean) {
    await clean();
  } else {
    await seed();
  }
})();
