/**
 * Stress Test — Bedas Run 2026 POST /payment
 *
 * Pilih skenario via env:
 *   SCENARIO=rampup   k6 run --env SCENARIO=rampup   k6.js
 *   SCENARIO=spike    k6 run --env SCENARIO=spike    k6.js
 *   SCENARIO=quota    k6 run --env SCENARIO=quota    k6.js  (jalankan seed.js dulu)
 *
 * Wajib:
 *   BASE_URL          URL server, default http://localhost:3000
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ── Konfigurasi ──────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const SCENARIO = __ENV.SCENARIO || 'rampup';

// ── Custom metrics ────────────────────────────────────────────────────────────
const errorRate    = new Rate('custom_errors');       // non-expected errors
const quotaHit     = new Counter('quota_hit');        // berapa kali 429
const dupHit       = new Counter('duplicate_hit');    // berapa kali 409
const insertedOk   = new Counter('inserted_ok');      // berapa kali 200

// ── Definisi skenario ─────────────────────────────────────────────────────────
const scenarioConfigs = {
  /**
   * Skenario 1 — Ramp-up
   * Naik bertahap ke 100 VU, tahan, lalu turun.
   * Tujuan: cari titik degradasi performa (latency mulai naik di mana).
   */
  rampup: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '30s', target: 50  },
      { duration: '30s', target: 100 },
      { duration: '30s', target: 50  },
      { duration: '30s', target: 0   },
    ],
    gracefulRampDown: '10s',
  },

  /**
   * Skenario 2 — Spike
   * Loncat dari 10 ke 500 VU dalam 5 detik, lalu turun.
   * Tujuan: lihat apakah DB connection pool / Supabase kewalahan saat burst tiba-tiba.
   */
  spike: {
    executor: 'ramping-vus',
    startVUs: 10,
    stages: [
      { duration: '5s',  target: 500 },
      { duration: '15s', target: 500 },
      { duration: '5s',  target: 10  },
    ],
    gracefulRampDown: '5s',
  },

  /**
   * Skenario 3 — Quota Boundary
   * Pre-condition: jalankan seed.js dulu (isi 990 baris dummy).
   * 20 VU serentak → hanya 10 yang boleh masuk, sisanya harus dapat 429.
   * Tujuan: validasi tidak ada insert ke-1001.
   * Catatan: VU dibatasi 20 agar tidak langsung kena MAX_CONCURRENT limiter
   *          sebelum sempat hit quota check di Supabase.
   */
  quota: {
    executor: 'constant-vus',
    vus: 20,
    duration: '15s',
  },
};

// ── Export options ────────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    [SCENARIO]: scenarioConfigs[SCENARIO],
  },
  thresholds: {
    // Latency — berlaku untuk semua skenario kecuali spike
    ...(SCENARIO !== 'spike' && {
      'http_req_duration': ['p(95)<2000', 'p(99)<5000'],
    }),
    // Error rate — 409 & 429 tidak dihitung error, hanya status 5xx
    'custom_errors': ['rate<0.01'],
    // Skenario quota: semua request harus dapat 429 setelah slot habis
    ...(SCENARIO === 'quota' && {
      'quota_hit': ['count>0'],
    }),
  },
};

// ── Helper: generate payload unik per VU & iterasi ───────────────────────────
function buildPayload() {
  const vu   = __VU;
  const iter = __ITER;
  // Format: 08XX-VVVV-IIII  (14 digit maks)
  const phone = `08${String(vu).padStart(5, '0')}${String(iter).padStart(5, '0')}`;

  return JSON.stringify({
    buyerName:  `Stress Test VU${vu}`,
    buyerPhone: phone,
    buyerEmail: `vu${vu}iter${iter}@test.com`,
    formData: {
      'Nama Lengkap':         `Stress Test VU${vu}`,
      'Nomor Whatsapp Aktif': phone,
      'Email':                `vu${vu}iter${iter}@test.com`,
      'Jenis Kelamin':        'Laki-Laki',
      'Tanggal Lahir':        '2000-01-01',
      'No. Kontak Darurat':   '08000000000',
      'Alamat':               'Jl. Stress Test No. 1',
      'Kategori Lari':        'BIG - MAN 2K',
      'Ukuran Kaos':          'M',
      'Golongan Darah':       'O',
      'Riwayat Penyakit':     'Tidak Ada',
      'Surat Pernyataan':     'Setuju',
    },
  });
}

// ── Main test function ────────────────────────────────────────────────────────
export default function () {
  const payload = buildPayload();

  const res = http.post(`${BASE_URL}/payment`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags:    { scenario: SCENARIO },
  });

  // Klasifikasi response
  const is200 = res.status === 200;
  const is409 = res.status === 409; // duplikat HP — expected
  const is429 = res.status === 429; // quota penuh — expected di skenario quota
  const is5xx = res.status >= 500;

  check(res, {
    'status bukan 5xx': () => !is5xx,
  });

  if (is200) insertedOk.add(1);
  if (is409) dupHit.add(1);
  if (is429) quotaHit.add(1);
  if (is5xx) {
    errorRate.add(1);
    // Log body error agar mudah diagnosa root cause
    console.error(`[5xx] VU=${__VU} iter=${__ITER} status=${res.status} dur=${res.timings.duration.toFixed(0)}ms body=${res.body?.slice(0, 200)}`);
  }

  // Log sample setiap 50 iterasi untuk non-error
  if (!is5xx && __ITER % 50 === 0) {
    console.log(`VU=${__VU} iter=${__ITER} status=${res.status} dur=${res.timings.duration.toFixed(0)}ms`);
  }

  sleep(0.1); // 100ms jeda antar request per VU
}

// ── Summary report ────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const m = data.metrics;
  const dur = m['http_req_duration'];

  // Counter metric → .values.count  |  Rate metric → .values.passes (truthy samples)
  const summary = {
    scenario:       SCENARIO,
    total_requests: m['http_reqs']?.values?.count   ?? 0,
    inserted_ok:    m['inserted_ok']?.values?.count  ?? 0,  // Counter
    quota_hit:      m['quota_hit']?.values?.count    ?? 0,  // Counter
    duplicate_hit:  m['duplicate_hit']?.values?.count ?? 0, // Counter
    errors_5xx:     m['custom_errors']?.values?.passes ?? 0, // Rate → passes = truthy count
    error_rate_pct: ((m['custom_errors']?.values?.rate ?? 0) * 100).toFixed(2) + '%',
    latency: {
      avg: (dur?.values?.avg        ?? 0).toFixed(2) + 'ms',
      p95: (dur?.values?.['p(95)']  ?? 0).toFixed(2) + 'ms',
      p99: (dur?.values?.['p(99)']  ?? 0).toFixed(2) + 'ms',
      max: (dur?.values?.max        ?? 0).toFixed(2) + 'ms',
    },
    rps: (m['http_reqs']?.values?.rate ?? 0).toFixed(2),
  };

  console.log('\n=== STRESS TEST SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  return {
    'stdout': JSON.stringify(summary, null, 2),
    [`result-${SCENARIO}.json`]: JSON.stringify(data, null, 2),
  };
}
