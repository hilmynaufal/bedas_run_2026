require('dotenv').config();

const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'example')));

// iPaymu config
const IPAYMU_API_KEY = process.env.IPAYMU_API_KEY;
const IPAYMU_VA = process.env.IPAYMU_VA;
const IPAYMU_URL = 'https://my.ipaymu.com/api/v2/payment';
// const IPAYMU_URL = 'https://sandbox.ipaymu.com/api/v2/payment';

// Supabase config
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Base URL server ini (untuk notifyUrl callback dari iPaymu)
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

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

app.post('/payment', async (req, res) => {
  const MOCK_MODE = process.env.IPAYMU_MOCK === 'true';

  if (!MOCK_MODE && (!IPAYMU_API_KEY || !IPAYMU_VA)) {
    return res.status(500).json({ error: 'IPAYMU_API_KEY and IPAYMU_VA env variables are required' });
  }

  const {
    returnUrl, cancelUrl,
    referenceId, buyerName, buyerPhone, buyerEmail,
    formData,
  } = req.body;

  const txReferenceId = referenceId || `ID${Date.now()}`;

  const fd = formData || {};

  // Harga berdasarkan kategori lari
  const kategori = (fd['Kategori Lari'] || '').toUpperCase();
  const HARGA = kategori.includes('CHILD') ? 100000 : 115000; // default Big
  const PRODUCT = ['Registrasi Bedas Run'];
  const QTY = ['1'];
  const PRICE = [String(HARGA)];
  const AMOUNT = String(HARGA);

  // 0. Cek duplikat nomor HP — tolak jika sudah ada transaksi pending/success
  const phoneToCheck = buyerPhone || fd['Nomor Whatsapp Aktif'] || null;
  if (phoneToCheck) {
    const { data: existing } = await supabase
      .from('transactions')
      .select('id, status')
      .eq('buyer_phone', phoneToCheck)
      .in('status', ['pending', 'success'])
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(409).json({
        error: 'Nomor HP sudah terdaftar',
        detail: `Nomor ${phoneToCheck} sudah memiliki pendaftaran aktif dengan status: ${existing[0].status}.`,
      });
    }
  }

  // 0b. Cek kuota — tolak jika sudah mencapai batas 1000 transaksi
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

  // 1. Simpan transaksi ke Supabase dengan status pending
  const { error: insertError } = await supabase
    .from('transactions')
    .insert({
      reference_id: txReferenceId,
      amount: parseInt(AMOUNT),
      status: 'pending',
      // buyer info
      buyer_name: buyerName || fd['Nama Lengkap'] || null,
      buyer_phone: buyerPhone || fd['Nomor Whatsapp Aktif'] || null,
      buyer_email: buyerEmail || fd['Email'] || null,
      // form fields
      jenis_kelamin: fd['Jenis Kelamin'] || null,
      tanggal_lahir: fd['Tanggal Lahir'] || null,
      kontak_darurat: fd['No. Kontak Darurat'] || null,
      alamat: fd['Alamat'] || null,
      kategori_lari: fd['Kategori Lari'] || null,
      ukuran_kaos: fd['Ukuran Kaos'] || null,
      golongan_darah: fd['Golongan Darah'] || null,
      riwayat_penyakit: fd['Riwayat Penyakit'] || null,
      surat_pernyataan: fd['Surat Pernyataan'] || null,
      // raw answers
      form_data: Object.keys(fd).length > 0 ? fd : null,
    });

  if (insertError) {
    return res.status(500).json({ error: 'Gagal menyimpan transaksi', detail: insertError.message });
  }

  // 2. Build payload iPaymu
  const body = {
    product: PRODUCT,
    qty: QTY,
    price: PRICE,
    amount: AMOUNT,
    returnUrl: returnUrl || `${BASE_URL}/payment/return`,
    cancelUrl: cancelUrl || `${BASE_URL}/cancel.html`,
    notifyUrl: `${BASE_URL}/callback`,
    paymentMethod: 'qris',
    buyerName: buyerName || fd['Nama Lengkap'] || null,
    buyerPhone: buyerPhone || fd['Nomor Whatsapp Aktif'] || null,
    buyerEmail: buyerEmail || fd['Email'] || null,
    //test
    referenceId: txReferenceId,
    // referenceId: 'ID1234'
  };

  console.log('[payment] notifyUrl:', body.notifyUrl);
  console.log('[payment] returnUrl:', body.returnUrl);
  console.log('[payment] cancelUrl:', body.cancelUrl);
  console.log('[payment] referenceId:', body.referenceId);
  console.log('[payment] body:', body);

  if (buyerName) body.buyerName = buyerName;
  if (buyerPhone) body.buyerPhone = buyerPhone;
  if (buyerEmail) body.buyerEmail = buyerEmail;

  // 3. Generate signature
  const bodyJson = JSON.stringify(body);
  const bodyHash = crypto.createHash('sha256').update(bodyJson).digest('hex');
  const stringToSign = `POST:${IPAYMU_VA}:${bodyHash}:${IPAYMU_API_KEY}`;
  const signature = crypto.createHmac('sha256', IPAYMU_API_KEY).update(stringToSign).digest('hex');
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

  // Mock mode: skip iPaymu, langsung return fake response (untuk stress testing)
  if (MOCK_MODE) {
    await supabase
      .from('transactions')
      .update({
        ipaymu_session_id: `mock-${txReferenceId}`,
        ipaymu_url: 'https://mock-payment.test/pay',
        updated_at: new Date().toISOString(),
      })
      .eq('reference_id', txReferenceId);

    return res.json({ Status: 200, Data: { Url: 'https://mock-payment.test/pay', SessionID: `mock-${txReferenceId}` } });
  }

  try {
    // 4. Forward ke iPaymu
    const response = await fetch(IPAYMU_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        va: IPAYMU_VA,
        signature: signature,
        timestamp: timestamp,
      },
      body: bodyJson,
    });

    const data = await response.json();

    // 5. Simpan session_id & url dari iPaymu ke record
    if (data.Status === 200 && data.Data) {
      await supabase
        .from('transactions')
        .update({
          ipaymu_session_id: data.Data.SessionID || null,
          ipaymu_url: data.Data.Url || null,
          updated_at: new Date().toISOString(),
        })
        .eq('reference_id', txReferenceId);
    }

    console.log('[payment] data:', data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Callback dari iPaymu setelah user bayar
app.post('/callback', async (req, res) => {
  console.log('[callback] Headers:', JSON.stringify(req.headers, null, 2));
  console.log('[callback] Payload diterima:', JSON.stringify(req.body, null, 2));

  const payload = { ...req.body };

  // 1. Verifikasi signature dari header X-Signature
  const receivedSignature = req.headers['x-signature'];

  const sortedData = Object.keys(payload).sort().reduce((acc, key) => {
    acc[key] = payload[key];
    return acc;
  }, {});

  const calculatedSignature = crypto
    .createHmac('sha256', IPAYMU_VA)
    .update(JSON.stringify(sortedData))
    .digest('hex');

  console.log('[callback] X-Signature received  :', receivedSignature);
  console.log('[callback] Signature calculated   :', calculatedSignature);

  // Signature sementara diabaikan
  if (calculatedSignature !== receivedSignature) {
    console.warn('[callback] Signature tidak cocok — diabaikan sementara');
  }

  const referenceId = payload.reference_id || payload.referenceId;
  const trxStatus = (payload.status || '').toLowerCase();
  console.log(`[callback] reference_id: ${referenceId} | status: ${trxStatus}`);

  if (!referenceId) {
    return res.status(400).json({ error: 'reference_id tidak ditemukan' });
  }

  // iPaymu status: "berhasil" = sukses, "expired"/"batal"/"gagal" = cancelled
  let newStatus = 'pending';
  if (trxStatus === 'berhasil') {
    newStatus = 'success';
  } else if (['expired', 'batal', 'gagal'].includes(trxStatus)) {
    newStatus = 'cancelled';
  }

  const { error } = await supabase
    .from('transactions')
    .update({
      status: newStatus,
      trx_id: payload.trx_id || null,
      tipe: payload.tipe || null,
      payment_method: payload.via || null,
      payment_channel: payload.channel || null,
      updated_at: new Date().toISOString(),
    })
    .eq('reference_id', referenceId);

  if (error) {
    console.error('[callback] Gagal update Supabase:', error.message);
    return res.status(500).json({ error: 'Gagal update status', detail: error.message });
  }

  console.log(`[callback] Status transaksi ${referenceId} diupdate ke: ${newStatus}`);
  res.status(200).json({ ok: true });
});

// Return URL dari iPaymu — pure redirect ke success.html
app.get('/payment/return', (req, res) => {
  console.log('[return] Query params:', req.query);
  res.redirect('/success.html');
});

// Cek status transaksi berdasarkan nomor HP
app.get('/check-transaction', async (req, res) => {
  const { phone } = req.query;

  if (!phone) {
    return res.status(400).json({ error: 'Parameter phone diperlukan' });
  }

  // 1. Ambil data transaksi dari Supabase berdasarkan nomor HP
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

  const trx = transactions[0];

  // 2. Jika tidak ada trx_id, kembalikan data dari DB saja
  if (!trx.trx_id) {
    return res.json({ source: 'db', transaction: trx });
  }

  // 3. Cek ke iPaymu menggunakan trx_id
  const body = {
    transactionId: trx.trx_id,
    account: IPAYMU_VA,
  };

  // Signature untuk formdata: hash dari JSON body
  const bodyJson = JSON.stringify(body);
  const bodyHash = crypto.createHash('sha256').update(bodyJson).digest('hex');
  const stringToSign = `POST:${IPAYMU_VA}:${bodyHash}:${IPAYMU_API_KEY}`;
  const signature = crypto.createHmac('sha256', IPAYMU_API_KEY).update(stringToSign).digest('hex');
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

  // Kirim sebagai formdata
  const formBody = new URLSearchParams(body).toString();

  try {
    const ipaymuRes = await fetch('https://my.ipaymu.com/api/v2/transaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        va: IPAYMU_VA,
        signature: signature,
        timestamp: timestamp,
      },
      body: formBody,
    });

    const ipaymuData = await ipaymuRes.json();
    console.log('[check-transaction] iPaymu response:', JSON.stringify(ipaymuData));

    // Sync status ke Supabase berdasarkan iPaymu Status
    // Status 1, 6, 7 = berhasil/paid
    if (ipaymuData.Status === 200 && ipaymuData.Data) {
      const iStatus = ipaymuData.Data.Status;
      const newStatus = [1, 6, 7].includes(iStatus) ? 'success' : iStatus === 0 ? 'pending' : 'cancelled';

      await supabase
        .from('transactions')
        .update({
          status: newStatus,
          trx_id: String(ipaymuData.Data.TransactionId),
          tipe: ipaymuData.Data.TypeDesc || null,
          payment_method: ipaymuData.Data.PaymentMethod || null,
          payment_channel: ipaymuData.Data.PaymentChannel || null,
          updated_at: new Date().toISOString(),
        })
        .eq('reference_id', trx.reference_id);

      // Refresh data transaksi dari DB setelah update
      const { data: updated } = await supabase
        .from('transactions')
        .select('*')
        .eq('reference_id', trx.reference_id)
        .single();

      return res.json({ source: 'ipaymu', transaction: updated || trx, ipaymu: ipaymuData });
    }

    res.json({ source: 'ipaymu', transaction: trx, ipaymu: ipaymuData });
  } catch (err) {
    console.error('[check-transaction] Gagal hit iPaymu:', err.message);
    res.json({ source: 'db', transaction: trx, error: 'Gagal menghubungi iPaymu' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
