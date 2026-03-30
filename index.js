const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// iPaymu config
const IPAYMU_API_KEY = process.env.IPAYMU_API_KEY;
const IPAYMU_VA = process.env.IPAYMU_VA;
const IPAYMU_URL = 'https://my.ipaymu.com/api/v2/payment';

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/payment', async (req, res) => {
  if (!IPAYMU_API_KEY || !IPAYMU_VA) {
    return res.status(500).json({ error: 'IPAYMU_API_KEY and IPAYMU_VA env variables are required' });
  }

  const {
    product, qty, price, amount,
    returnUrl, cancelUrl, notifyUrl,
    referenceId, buyerName, buyerPhone, buyerEmail,
  } = req.body;

  const body = {
    product: product || ['Product'],
    qty: qty || ['1'],
    price: price || ['10000'],
    amount: amount || '10000',
    returnUrl: returnUrl || 'https://your-website.com/thank-you-page',
    cancelUrl: cancelUrl || 'https://your-website.com/cancel-page',
    notifyUrl: notifyUrl || 'https://your-website.com/callback-url',
    referenceId: referenceId || Date.now().toString(),
  };

  // optional fields — only include if provided (not empty)
  if (buyerName) body.buyerName = buyerName;
  if (buyerPhone) body.buyerPhone = buyerPhone;
  if (buyerEmail) body.buyerEmail = buyerEmail;

  // generate signature sesuai docs iPaymu:
  // HTTPMethod:VaNumber:Lowercase(SHA-256(RequestBody)):ApiKey
  const bodyJson = JSON.stringify(body);
  const bodyHash = crypto.createHash('sha256').update(bodyJson).digest('hex'); // already lowercase
  const stringToSign = `POST:${IPAYMU_VA}:${bodyHash}:${IPAYMU_API_KEY}`;
  const signature = crypto.createHmac('sha256', IPAYMU_API_KEY).update(stringToSign).digest('hex');
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

  try {
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
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
