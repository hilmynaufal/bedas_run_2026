-- Script untuk menambahkan kolom sistem scan racepack pada tabel transactions

ALTER TABLE transactions 
ADD COLUMN is_racepack_claimed BOOLEAN DEFAULT false,
ADD COLUMN racepack_claimed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN racepack_claimed_by TEXT;
