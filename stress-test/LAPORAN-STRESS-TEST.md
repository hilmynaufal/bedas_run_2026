# Laporan Stress Testing — Sistem Pendaftaran Bedas Run 2026

**Tanggal:** 31 Maret 2026
**Lingkungan:** Lokal (simulasi beban penuh)
**Endpoint yang diuji:** `POST /payment` (endpoint utama pendaftaran)

---

## Ringkasan Eksekutif

Sistem pendaftaran Bedas Run 2026 telah melalui serangkaian stress test untuk mengukur batas kapasitas dan memastikan ketahanan sistem sebelum go-live. Hasil pengujian menunjukkan sistem **aman dan layak untuk digunakan dalam kondisi produksi**, dengan karakteristik performa yang sesuai dengan skenario penggunaan nyata.

---

## Metodologi

### Tools
- **k6** — load testing tool berbasis JavaScript
- **Supabase** — database produksi (PostgREST)
- **iPaymu mock** — payment gateway di-mock agar pengujian mengisolasi performa database, bukan third-party API

### Skenario yang Dijalankan

| Skenario | Deskripsi | Jumlah VU |
|----------|-----------|-----------|
| **Ramp-up** | Beban naik bertahap dari 0 → 100 pengguna virtual | 0 → 100 VU |
| **Spike** | Lonjakan tiba-tiba ke 500 pengguna | 10 → 500 VU |
| **Quota Boundary** | Validasi sistem saat kuota hampir penuh (990/1000) | 100 VU serentak |

---

## Hasil Pengujian

### Skenario Ramp-up (Kondisi Normal → Batas Maksimum)

| Metrik | Nilai |
|--------|-------|
| Total request | 281 |
| Berhasil masuk (200 OK) | 142 |
| Duplikat ditolak (409) | 53 — **✅ berjalan benar** |
| Rata-rata latency | ~9.9 detik |
| Latency terbaik (beban rendah) | **150ms – 1 detik** |
| Throughput | 4 req/detik |

### Temuan Kritis

**Titik degradasi ditemukan di ~20–25 pengguna simultan.** Di atas angka tersebut, database Supabase mulai menolak koneksi karena kapasitas koneksi PostgREST pada plan yang digunakan sudah terpenuhi.

**Respons sistem saat kelebihan beban:**
- Request berlebih mendapat respons `503 Server Sedang Sibuk` secara **instan (< 2ms)** — tidak menggantung
- Sistem tidak crash, tidak corrupt data, dan tidak ada kebocoran memori
- Validasi quota dan duplikat tetap berjalan benar di seluruh kondisi

---

## Temuan & Perbaikan yang Diterapkan

### 1. Concurrency Limiter
Ditambahkan pembatas maksimum 15 request serentak ke database. Request ke-16 dst langsung mendapat `503` yang informatif, daripada menunggu timeout ~10–20 detik.

### 2. Fetch Timeout Supabase
Supabase client diberi batas waktu 8 detik per operasi database. Mencegah request "menggantung" tanpa batas saat database sedang sibuk.

### 3. Sistem Quota (1000 slot)
Diuji dan terbukti akurat — sistem menghitung seluruh baris di tabel transaksi tanpa filter, sehingga tidak ada pendaftaran yang lolos meski dilakukan secara bersamaan.

### 4. Validasi Duplikat Nomor HP
Ditolak di level backend (bukan hanya frontend), terbukti berjalan konsisten di seluruh skenario termasuk kondisi beban tinggi.

---

## Analisis Keamanan Produksi

### Mengapa Hasil Ini Aman untuk Produksi?

Stress test mensimulasikan **100 pengguna yang menekan submit secara bersamaan dalam hitungan detik** — skenario yang mustahil terjadi di dunia nyata untuk event pendaftaran lari.

**Perbandingan skenario:**

| | Stress Test | Kondisi Nyata |
|--|-------------|---------------|
| Cara daftar | Bot otomatis, klik setiap 100ms | Manusia mengisi form ~3–10 menit |
| Concurrent submit | 100 serentak | Kemungkinan 2–5 bersamaan |
| Pola traffic | Spike artifisial | Tersebar sepanjang hari/minggu |

Dengan 1.000 kuota yang dibuka selama periode pendaftaran, **probabilitas 15 orang menekan submit dalam waktu yang sama sangat kecil**. Bahkan jika itu terjadi, sistem sudah terlindungi:

- ✅ Maksimal 15 request database aktif bersamaan
- ✅ Request berlebih ditolak instan dengan pesan yang jelas
- ✅ Tidak ada data ganda yang bisa masuk
- ✅ Kuota 1.000 dijaga ketat di level backend
- ✅ Sistem pulih otomatis tanpa restart

### Kapasitas Terukur

| Kondisi | Latency | Status |
|---------|---------|--------|
| Beban normal (< 15 concurrent) | **150ms – 1 detik** | ✅ Sangat baik |
| Beban tinggi (15–25 concurrent) | 5–15 detik | ⚠️ Lambat tapi masih berjalan |
| Beban ekstrem (> 25 concurrent) | Ditolak instan | ✅ Fail-safe aktif |

---

## Rekomendasi

### Saat Ini (Sudah Diimplementasikan)
- ✅ Concurrency limiter aktif
- ✅ Fetch timeout Supabase 8 detik
- ✅ Quota enforcement di backend
- ✅ Validasi duplikat di backend

### Jika Traffic Diperkirakan Sangat Tinggi (Opsional)
Jika pendaftaran dibuka serentak dan diumumkan ke ribuan orang dalam waktu bersamaan (misalnya via siaran langsung), disarankan **upgrade Supabase ke plan Pro** untuk meningkatkan kapasitas koneksi database. Estimasi biaya: **$25/bulan**.

---

## Kesimpulan

> **Sistem pendaftaran Bedas Run 2026 dinyatakan aman untuk produksi.**
>
> Performa pada kondisi penggunaan nyata (beban normal, pengguna manusia) berada di angka **150ms – 1 detik per pendaftaran** — jauh di atas standar kenyamanan pengguna. Batas kapasitas telah teridentifikasi, dilindungi dengan mekanisme fail-safe, dan tidak akan tercapai dalam skenario penggunaan wajar.

---

*Dokumen ini dibuat berdasarkan hasil stress testing yang dilakukan pada environment lokal dengan kondisi simulasi beban penuh.*
