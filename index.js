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
app.use(express.static(path.join(__dirname, 'example')));

// iPaymu config
const IPAYMU_API_KEY = process.env.IPAYMU_API_KEY;
const IPAYMU_VA = process.env.IPAYMU_VA;
const IPAYMU_URL = 'https://my.ipaymu.com/api/v2/payment';

// Supabase config
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Base URL server ini (untuk notifyUrl callback dari iPaymu)
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/payment', async (req, res) => {
  if (!IPAYMU_API_KEY || !IPAYMU_VA) {
    return res.status(500).json({ error: 'IPAYMU_API_KEY and IPAYMU_VA env variables are required' });
  }

  const {
    returnUrl, cancelUrl,
    referenceId, buyerName, buyerPhone, buyerEmail,
    formData,
  } = req.body;

  // Konfigurasi produk & harga — tidak diterima dari frontend
  const PRODUCT = ['Registrasi Bedas Run'];
  const QTY = ['1'];
  const PRICE = ['1000'];
  const AMOUNT = '1000';

  const txReferenceId = referenceId || `ORDER-${Date.now()}`;

  const fd = formData || {};

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
    returnUrl: returnUrl || `${BASE_URL}/success.html`,
    cancelUrl: cancelUrl || `${BASE_URL}/cancel.html`,
    notifyUrl: `${BASE_URL}/payment/callback`,
    referenceId: txReferenceId,
  };

  console.log('[payment] notifyUrl:', body.notifyUrl);
  console.log('[payment] returnUrl:', body.returnUrl);
  console.log('[payment] cancelUrl:', body.cancelUrl);

  if (buyerName) body.buyerName = buyerName;
  if (buyerPhone) body.buyerPhone = buyerPhone;
  if (buyerEmail) body.buyerEmail = buyerEmail;

  // 3. Generate signature
  const bodyJson = JSON.stringify(body);
  const bodyHash = crypto.createHash('sha256').update(bodyJson).digest('hex');
  const stringToSign = `POST:${IPAYMU_VA}:${bodyHash}:${IPAYMU_API_KEY}`;
  const signature = crypto.createHmac('sha256', IPAYMU_API_KEY).update(stringToSign).digest('hex');
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

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
          ipaymu_session_id: data.Data.SessionId || null,
          ipaymu_url: data.Data.Url || null,
          updated_at: new Date().toISOString(),
        })
        .eq('reference_id', txReferenceId);
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Callback dari iPaymu setelah user bayar
app.post('/payment/callback', async (req, res) => {
  console.log('[callback] Payload diterima:', JSON.stringify(req.body, null, 2));

  const payload = { ...req.body };

  // 1. Verifikasi signature (secret key = VA number)
  const receivedSignature = payload.signature;
  delete payload.signature;

  const sortedData = Object.keys(payload).sort().reduce((acc, key) => {
    acc[key] = payload[key];
    return acc;
  }, {});

  const calculatedSignature = crypto
    .createHmac('sha256', IPAYMU_VA)
    .update(JSON.stringify(sortedData))
    .digest('hex');

  if (calculatedSignature !== receivedSignature) {
    console.error('[callback] Signature tidak valid — received:', receivedSignature, '| calculated:', calculatedSignature);
    return res.status(400).send('Invalid Signature');
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
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('reference_id', referenceId);

  if (error) {
    console.error('[callback] Gagal update Supabase:', error.message);
    return res.status(500).json({ error: 'Gagal update status', detail: error.message });
  }

  console.log(`[callback] Status transaksi ${referenceId} diupdate ke: ${newStatus}`);
  res.status(200).json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
