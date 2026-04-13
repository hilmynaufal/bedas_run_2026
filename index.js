require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const xlsx = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'https://registrasi.bigandchildrun.com',
    /^http:\/\/localhost(:\d+)?$/,  // lokal dev
  ],
  methods: ['GET', 'POST'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend statis dari folder example/
app.use(express.static(path.join(__dirname, 'example')));

// Konfigurasi rekening bank transfer — isi via environment variables
const BANK_NAME = process.env.BANK_NAME || 'BCA';
const BANK_ACCOUNT_NUMBER = process.env.BANK_ACCOUNT_NUMBER || '1234567890';
const BANK_ACCOUNT_NAME = process.env.BANK_ACCOUNT_NAME || 'Panitia Bedas Run 2026';

// Admin auth — set ADMIN_KEY di env, jangan hardcode
const ADMIN_KEY = process.env.ADMIN_KEY || '';

// Supabase config — dengan fetch timeout 8s agar fail-fast saat Supabase overload
const fetch = require('node-fetch');
const SUPABASE_FETCH_TIMEOUT = parseInt(process.env.SUPABASE_FETCH_TIMEOUT || '8000', 10);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    global: {
      fetch: (url, options = {}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SUPABASE_FETCH_TIMEOUT);
        return fetch(url, { ...options, signal: controller.signal })
          .finally(() => clearTimeout(timer));
      },
    },
  }
);

// URL frontend (untuk redirect)
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://registrasi.bigandchildrun.com').replace(/\/$/, '');

// Concurrency limiter — cegah Supabase dibanjiri koneksi serentak
let activePayments = 0;
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '15', 10);

// Multer: simpan file di memori, lalu upload ke Supabase Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // maks 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format file tidak didukung. Gunakan JPG, PNG, atau WEBP.'));
    }
  },
});

// Multer untuk surat pernyataan — terima gambar + PDF, maks 10 MB
const uploadSurat = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format tidak didukung. Gunakan JPG, PNG, atau PDF.'));
    }
  },
});

// Multer untuk excel bulk insert
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format tidak didukung. Gunakan file Excel (.xls, .xlsx) atau CSV.'));
    }
  }
});

// Mapping kategori lari → prefix BIB number
function getBibPrefix(kategori) {
  const k = (kategori || '').toUpperCase();
  if (k.includes('BIG') && k.includes('WOMAN')) return 'BW'; // harus sebelum MAN (WOMAN ⊃ MAN)
  if (k.includes('BIG') && k.includes('MAN')) return 'BM';
  if (k.includes('CHILD') && k.includes('GIRL')) return 'CG';
  if (k.includes('CHILD') && k.includes('BOY')) return 'CB';
  return 'XX'; // fallback jika kategori tidak dikenali
}

// Generate BIB number berikutnya berdasarkan prefix (BM0001, BW0042, dst)
async function generateBibNumber(prefix) {
  const { data } = await supabase
    .from('transactions')
    .select('reference_id')
    .like('reference_id', `${prefix}%`)
    .order('reference_id', { ascending: false })
    .limit(1);

  let nextNum = 1;
  if (data && data.length > 0) {
    const lastNum = parseInt(data[0].reference_id.slice(prefix.length), 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

// Generate kode unik 3 digit (001–999) untuk membedakan nominal transfer
function generateUniqueCode() {
  return Math.floor(Math.random() * 999) + 1;
}

// Middleware auth admin — cek header x-admin-key
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(500).json({ error: 'ADMIN_KEY belum diset di server' });
  }
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/quota', async (req, res) => {
  const QUOTA_TOTAL = 1000;
  const { count, error } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true });

  if (error) {
    return res.status(500).json({ error: 'Gagal mengambil data kuota', detail: error.message });
  }

  const quota_used = count || 0;
  const quota_available = Math.max(0, QUOTA_TOTAL - quota_used);
  res.json({ quota_used, quota_total: QUOTA_TOTAL, quota_available });
});

// ─── POST /payment ────────────────────────────────────────────────────────────
// Menerima data pendaftaran, validasi, simpan ke DB, return info rekening bank
app.post('/payment', async (req, res) => {
  // Tolak langsung jika sudah terlalu banyak request serentak
  if (activePayments >= MAX_CONCURRENT) {
    return res.status(503).json({
      error: 'Server sedang sibuk',
      detail: 'Terlalu banyak pendaftaran diproses bersamaan, silakan coba lagi dalam beberapa detik.',
    });
  }
  activePayments++;

  let released = false;
  const release = () => { if (!released) { released = true; activePayments--; } };
  res.on('finish', release);
  res.on('close', release);

  const { buyerName, buyerPhone, buyerEmail, formData } = req.body;
  const fd = formData || {};

  // Harga berdasarkan kategori lari
  const kategori = (fd['Kategori Lari'] || '').toUpperCase();
  const HARGA = kategori.includes('CHILD') ? 100000 : 115000;

  // 0. Cek duplikat nomor HP
  const phoneToCheck = buyerPhone || fd['Nomor Whatsapp Aktif'] || null;
  if (phoneToCheck) {
    const { data: existing } = await supabase
      .from('transactions')
      .select('id, status')
      .eq('buyer_phone', phoneToCheck)
      .in('status', ['pending_payment', 'pending_verification', 'success'])
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(409).json({
        error: 'Nomor HP sudah terdaftar',
        detail: `Nomor ${phoneToCheck} sudah memiliki pendaftaran aktif dengan status: ${existing[0].status}.`,
      });
    }
  }

  // 0b. Cek kuota
  const QUOTA_TOTAL = 1000;
  const { count: quotaCount, error: quotaError } = await supabase
    .from('transactions')
    .select('*', { count: 'exact', head: true });

  if (quotaError) {
    return res.status(500).json({ error: 'Gagal memeriksa kuota', detail: quotaError.message });
  }

  if ((quotaCount || 0) >= QUOTA_TOTAL) {
    return res.status(429).json({
      error: 'Quota pendaftaran penuh',
      detail: 'Maaf, kuota pendaftaran sudah mencapai batas maksimum.',
    });
  }

  // 0c. Generate BIB number
  const bibPrefix = getBibPrefix(fd['Kategori Lari'] || '');
  const txReferenceId = await generateBibNumber(bibPrefix);

  // 0d. Generate kode unik untuk nominal transfer
  const uniqueCode = generateUniqueCode();
  const totalTransfer = HARGA + uniqueCode;

  // 1. Simpan transaksi ke Supabase dengan status pending_payment
  const { error: insertError } = await supabase
    .from('transactions')
    .insert({
      reference_id: txReferenceId,
      amount: HARGA,
      unique_code: uniqueCode,
      status: 'pending_payment',
      buyer_name: buyerName || fd['Nama Lengkap'] || null,
      buyer_phone: buyerPhone || fd['Nomor Whatsapp Aktif'] || null,
      buyer_email: buyerEmail || fd['Email'] || null,
      jenis_kelamin: fd['Jenis Kelamin'] || null,
      tanggal_lahir: fd['Tanggal Lahir'] || null,
      kontak_darurat: fd['No. Kontak Darurat'] || null,
      alamat: fd['Alamat'] || null,
      kategori_lari: fd['Kategori Lari'] || null,
      ukuran_kaos: fd['Ukuran Kaos'] || null,
      golongan_darah: fd['Golongan Darah'] || null,
      riwayat_penyakit: fd['Riwayat Penyakit'] || null,
      surat_pernyataan: fd['Surat Pernyataan'] || null,
      nama_instansi: fd['Nama Instansi (peserta dari unsur pemerintahan, kosongkan jika masyarakat umum)'] || null,
      form_data: Object.keys(fd).length > 0 ? fd : null,
    });

  if (insertError) {
    return res.status(500).json({ error: 'Gagal menyimpan transaksi', detail: insertError.message });
  }

  console.log(`[payment] Pendaftaran berhasil: ${txReferenceId}, total transfer: ${totalTransfer}`);

  // 2. Return info transfer bank ke frontend
  res.json({
    status: 'pending_payment',
    referenceId: txReferenceId,
    amount: HARGA,
    uniqueCode: uniqueCode,
    totalTransfer: totalTransfer,
    bank: {
      name: BANK_NAME,
      accountNumber: BANK_ACCOUNT_NUMBER,
      accountName: BANK_ACCOUNT_NAME,
    },
  });
});

// ─── POST /upload-proof ───────────────────────────────────────────────────────
// Terima bukti transfer (gambar), upload ke Supabase Storage, update status
app.post('/upload-proof', upload.single('proof'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'File bukti transfer wajib diupload' });
  }

  const referenceId = req.body.referenceId;
  if (!referenceId) {
    return res.status(400).json({ error: 'referenceId wajib disertakan' });
  }

  // Cek transaksi ada dan statusnya masih boleh upload
  const { data: trx, error: findError } = await supabase
    .from('transactions')
    .select('reference_id, status')
    .eq('reference_id', referenceId)
    .single();

  if (findError || !trx) {
    return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  }

  if (!['pending_payment', 'rejected'].includes(trx.status)) {
    return res.status(409).json({
      error: 'Bukti tidak dapat diupload',
      detail: `Status transaksi saat ini: ${trx.status}`,
    });
  }

  // Upload ke Supabase Storage bucket "payment-proofs"
  const ext = req.file.originalname.split('.').pop() || 'jpg';
  const filename = `${referenceId}_${Date.now()}.${ext}`;

  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('payment-proofs')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: true,
    });

  if (uploadError) {
    console.error('[upload-proof] Gagal upload ke Supabase Storage:', uploadError.message);
    return res.status(500).json({ error: 'Gagal mengupload bukti', detail: uploadError.message });
  }

  // Ambil public URL
  const { data: urlData } = supabase.storage
    .from('payment-proofs')
    .getPublicUrl(filename);

  const proofUrl = urlData?.publicUrl || null;

  // Update status → pending_verification
  const { error: updateError } = await supabase
    .from('transactions')
    .update({
      status: 'pending_verification',
      payment_proof_url: proofUrl,
      reject_reason: null, // hapus alasan reject sebelumnya jika re-upload
      updated_at: new Date().toISOString(),
    })
    .eq('reference_id', referenceId);

  if (updateError) {
    return res.status(500).json({ error: 'Gagal update status', detail: updateError.message });
  }

  console.log(`[upload-proof] Bukti diupload untuk ${referenceId}: ${proofUrl}`);
  res.json({ ok: true, status: 'pending_verification', proofUrl });
});

// ─── POST /upload-surat ───────────────────────────────────────────────────────
// Terima surat pernyataan (PDF/gambar), upload ke Supabase Storage, simpan URL
// Opsional — dipanggil fire-and-forget dari frontend setelah POST /payment berhasil
app.post('/upload-surat', uploadSurat.single('surat'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'File surat pernyataan wajib disertakan' });
  }

  const { referenceId } = req.body;
  if (!referenceId) {
    return res.status(400).json({ error: 'referenceId wajib disertakan' });
  }

  // Verifikasi transaksi ada
  const { data: trx, error: findError } = await supabase
    .from('transactions')
    .select('reference_id')
    .eq('reference_id', referenceId)
    .single();

  if (findError || !trx) {
    return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  }

  const ext = req.file.originalname.split('.').pop().toLowerCase() || 'pdf';
  const filename = `${referenceId}_surat_${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from('surat-pernyataan')
    .upload(filename, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: true,
    });

  if (uploadError) {
    console.error('[upload-surat] Gagal upload:', uploadError.message);
    return res.status(500).json({ error: 'Gagal mengupload surat', detail: uploadError.message });
  }

  const { data: urlData } = supabase.storage
    .from('surat-pernyataan')
    .getPublicUrl(filename);

  const suratUrl = urlData?.publicUrl || null;

  await supabase
    .from('transactions')
    .update({ surat_pernyataan_url: suratUrl, updated_at: new Date().toISOString() })
    .eq('reference_id', referenceId);

  console.log(`[upload-surat] Surat diupload untuk ${referenceId}: ${suratUrl}`);
  res.json({ ok: true, suratUrl });
});

// ─── GET /check-transaction ───────────────────────────────────────────────────
// Cek status transaksi berdasarkan nomor HP — langsung dari DB
app.get('/check-transaction', async (req, res) => {
  const { phone } = req.query;

  if (!phone) {
    return res.status(400).json({ error: 'Parameter phone diperlukan' });
  }

  const { data: transactions, error: dbError } = await supabase
    .from('transactions')
    .select('*')
    .eq('buyer_phone', phone)
    .order('created_at', { ascending: false });

  if (dbError) {
    return res.status(500).json({ error: 'Gagal mengambil data transaksi', detail: dbError.message });
  }

  if (!transactions || transactions.length === 0) {
    return res.status(404).json({ error: 'Transaksi tidak ditemukan untuk nomor HP ini' });
  }

  res.json({
    transaction: transactions[0],
    bank: { name: BANK_NAME, accountNumber: BANK_ACCOUNT_NUMBER, accountName: BANK_ACCOUNT_NAME },
  });
});

// ─── GET /admin/pending ───────────────────────────────────────────────────────
// List transaksi pending_verification (butuh ADMIN_KEY)
app.get('/admin/pending', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('transactions')
    .select('reference_id, buyer_name, buyer_phone, buyer_email, kategori_lari, amount, unique_code, payment_proof_url, created_at, updated_at')
    .eq('status', 'pending_verification')
    .order('updated_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Gagal mengambil data', detail: error.message });
  }

  res.json({ count: data.length, transactions: data });
});

// ─── GET /admin/transactions ──────────────────────────────────────────────────
// List semua transaksi, bisa filter by status (butuh ADMIN_KEY)
app.get('/admin/transactions', requireAdmin, async (req, res) => {
  const { status, search } = req.query;
  const ALLOWED_STATUSES = ['pending_payment', 'pending_verification', 'success', 'rejected', 'cancelled'];

  let query = supabase
    .from('transactions')
    .select('*')
    .order('created_at', { ascending: false });

  if (status && ALLOWED_STATUSES.includes(status)) {
    query = query.eq('status', status);
  }

  if (search) {
    query = query.or(`buyer_name.ilike.%${search}%,buyer_phone.ilike.%${search}%,reference_id.ilike.%${search}%`);
  }

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ error: 'Gagal mengambil data', detail: error.message });
  }

  // Hitung total per status
  const summary = {};
  (data || []).forEach(t => {
    summary[t.status] = (summary[t.status] || 0) + 1;
  });

  res.json({ total: data.length, summary, transactions: data });
});

// ─── POST /admin/verify ───────────────────────────────────────────────────────
// Admin approve atau reject transaksi (butuh ADMIN_KEY)
app.post('/admin/verify', requireAdmin, async (req, res) => {
  const { referenceId, action, reason, verifiedBy } = req.body;

  if (!referenceId || !action) {
    return res.status(400).json({ error: 'referenceId dan action wajib diisi' });
  }

  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action harus "approve" atau "reject"' });
  }

  if (action === 'reject' && !reason) {
    return res.status(400).json({ error: 'Alasan penolakan (reason) wajib diisi saat reject' });
  }

  // Pastikan transaksi ada dan statusnya pending_verification
  const { data: trx, error: findError } = await supabase
    .from('transactions')
    .select('reference_id, status')
    .eq('reference_id', referenceId)
    .single();

  if (findError || !trx) {
    return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  }

  if (trx.status !== 'pending_verification') {
    return res.status(409).json({
      error: 'Transaksi tidak dalam status pending_verification',
      detail: `Status saat ini: ${trx.status}`,
    });
  }

  const newStatus = action === 'approve' ? 'success' : 'rejected';
  const updateFields = {
    status: newStatus,
    verified_by: verifiedBy || 'admin',
    verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (action === 'reject') {
    updateFields.reject_reason = reason;
  }

  const { error: updateError } = await supabase
    .from('transactions')
    .update(updateFields)
    .eq('reference_id', referenceId);

  if (updateError) {
    return res.status(500).json({ error: 'Gagal update status', detail: updateError.message });
  }

  console.log(`[admin/verify] ${referenceId} → ${newStatus} by ${verifiedBy || 'admin'}`);
  res.json({ ok: true, referenceId, status: newStatus });
});

// ─── POST /admin/bulk-insert ──────────────────────────────────────────────────
// Admin bulk insert data pendaftaran menggunakan Excel/CSV (butuh ADMIN_KEY)
app.post('/admin/bulk-insert', requireAdmin, uploadExcel.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'File Excel/CSV wajib diunggah' });
  }

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'File kosong atau tidak memiliki data' });
    }

    const maxRows = 500; // batasi demi keamanan & performa db
    if (rows.length > maxRows) {
      return res.status(400).json({ error: `Terlalu banyak baris. Maksimal ${maxRows} per upload.` });
    }

    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    // Proses secara berurutan untuk menjamin generate BIB aman (tidak race condition)
    for (let i = 0; i < rows.length; i++) {
      const rw = rows[i];
      // Cari nama/hp, fleksibel lowercase/uppercase karena kolom excel bervariasi
      const getCol = (possibleNames) => {
        const key = Object.keys(rw).find(k => possibleNames.some(pn => k.toLowerCase().includes(pn.toLowerCase())));
        return key ? rw[key] : '';
      };

      const name = getCol(['nama', 'name']) || '-';
      const phoneRaw = getCol(['whatsapp', 'wa', 'hp', 'phone', 'telepon']) || '';
      const email = getCol(['email']) || '';

      const formD = {};
      Object.keys(rw).forEach(k => {
        formD[k] = rw[k] || '';
      });

      const phone = String(phoneRaw).trim();
      if (!phone) {
        failedCount++;
        errors.push(`Baris ${i + 2}: Nomor WhatsApp kosong.`);
        continue;
      }

      // 1. Cek duplikat no HP
      const { data: existing } = await supabase
        .from('transactions')
        .select('id, status')
        .eq('buyer_phone', phone)
        .in('status', ['pending_payment', 'pending_verification', 'success'])
        .limit(1);

      if (existing && existing.length > 0) {
        failedCount++;
        errors.push(`Baris ${i + 2} (${name}): Nomor HP ${phone} sudah ada (Status: ${existing[0].status})`);
        continue;
      }

      const kategoriVal = getCol(['kategori lari', 'kategori']) || 'Lainnya';
      const bibPrefix = getBibPrefix(kategoriVal);
      const txReferenceId = await generateBibNumber(bibPrefix);

      const HARGA = kategoriVal.toUpperCase().includes('CHILD') ? 100000 : 115000;
      const uniqueCode = generateUniqueCode();

      // Default status = success jika insert dari admin, asumsi sudah lunas kolektif.
      // Jika butuh bisa diatur jadi pending_payment.
      const rowStatus = getCol(['status']) || 'success';

      const { error: insErr } = await supabase
        .from('transactions')
        .insert({
          reference_id: txReferenceId,
          amount: HARGA,
          unique_code: uniqueCode,
          status: rowStatus,
          buyer_name: name,
          buyer_phone: phone,
          buyer_email: email,
          jenis_kelamin: getCol(['jenis kelamin', 'gender']),
          tanggal_lahir: getCol(['tanggal lahir', 'tgl lahir', 'dob']),
          kontak_darurat: getCol(['kontak darurat', 'emergency']),
          alamat: getCol(['alamat', 'address']),
          kategori_lari: kategoriVal,
          ukuran_kaos: getCol(['ukuran kaos', 'ukuran baju', 'size']),
          golongan_darah: getCol(['golongan darah', 'goldar']),
          riwayat_penyakit: getCol(['riwayat penyakit']),
          nama_instansi: getCol(['instansi']),
          form_data: formD,
          verified_by: 'admin_bulk',
          verified_at: rowStatus === 'success' ? new Date().toISOString() : null
        });

      if (insErr) {
        failedCount++;
        errors.push(`Baris ${i + 2} (${name}): DB Error - ${insErr.message}`);
      } else {
        successCount++;
      }
    }

    res.json({
      ok: true,
      summary: {
        total: rows.length,
        success: successCount,
        failed: failedCount,
        errors: errors
      }
    });

  } catch (err) {
    res.status(500).json({ error: 'Gagal memproses file Excel', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
