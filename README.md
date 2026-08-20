# Sentra CCTV

Dashboard live-view CCTV lintas brand untuk jaringan kantor. Aplikasi menyediakan autentikasi, account per bidang, RBAC, pembagian kamera per role, dan grid live view melalui MediaMTX/WebRTC.

## Arsitektur

```text
Camera/NVR RTSP (H.264 substream)
             |
          MediaMTX ---- WebRTC ---- Browser/Mini PC
             ^
             |
             Vue dashboard + Node API + PostgreSQL
```

Backend **tidak menyimpan RTSP URL atau password kamera di browser**. RTSP URL hanya ditulis di `deploy/mediamtx.yml`; database dashboard hanya menyimpan nama `stream_path`.

## Fitur MVP

- Session login menggunakan cookie HttpOnly dan token yang di-hash di database
- Password disimpan menggunakan `scrypt` dengan salt acak
- Role bawaan: Administrator, Supervisor, Viewer
- Pembagian kamera many-to-many berdasarkan role
- Management user dan kamera
- Live grid 1, 4, 9, 16; pencarian dan pagination
- Audit log login serta perubahan data penting
- PostgreSQL terpusat untuk user, kamera, audit, sesi, dan indeks rekaman
- Docker Compose untuk dashboard dan MediaMTX

## Menjalankan untuk development

Persyaratan: Node.js 24+.

```powershell
npm install
$env:ADMIN_PASSWORD="PasswordAdminYangKuat!"
npm run dev
```

- Frontend development: `http://localhost:5173`
- API: `http://localhost:8080`
- Username awal: `admin`
- Password awal: nilai `ADMIN_PASSWORD`, atau `ChangeMe123!` hanya jika environment tidak diset pada mode lokal

Untuk mencoba mode production lokal:

```powershell
npm run build
$env:ADMIN_PASSWORD="PasswordAdminYangKuat!"
npm start
```

Buka `http://localhost:8080`.

## Deployment server dengan Docker

1. Siapkan Ubuntu Server dengan Docker Engine dan plugin Docker Compose.
2. Salin project ke server, lalu salin `.env.example` menjadi `.env`. Untuk akses HTTP biasa di jaringan kantor, biarkan `SECURE_COOKIES=false`; jika sudah memakai HTTPS, ubah menjadi `true`.
3. Isi koneksi PostgreSQL, password admin yang kuat, dan IP LAN server:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ganti-dengan-password-panjang
SERVER_LAN_IP=192.168.10.5
DATABASE_URL=postgresql://sentra_cctv_app:password@10.8.140.69:5432/sentra_cctv
DATABASE_SSL=false
```

4. Edit `deploy/mediamtx.yml`, lalu isi RTSP substream masing-masing kamera/NVR.
5. Jalankan:

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:8080/api/health
```

6. Jika health check menghasilkan `{"ok":true,"database":"connected"}`, buka `http://IP-SERVER:8080` dari Mini PC client.

Database dan tabel dibuat otomatis ketika dashboard pertama kali berjalan. Jangan commit `.env` karena berisi password database dan admin.

## Menambahkan kamera

Misalnya konfigurasi MediaMTX:

```yaml
paths:
  lobby-barat:
    source: rtsp://viewer:password@192.168.10.30:554/substream
    sourceOnDemand: true
```

Contoh Wisenet/Hanwha yang mengizinkan RTSP tanpa autentikasi:

```yaml
paths:
  wisenet-01:
    source: rtsp://192.168.141.111:554/profile2/media.smp
    sourceOnDemand: true
```

Untuk Wisenet yang masih meminta login, gunakan format
`rtsp://username:password@192.168.141.111:554/profile2/media.smp`. Profile 2 biasanya
merupakan substream dan lebih sesuai untuk grid dashboard.

Di menu **Management → Tambah kamera**, isi **Stream path** dengan `lobby-barat`. Jangan masukkan RTSP URL atau password ke form dashboard.

Jika kamera hanya menyediakan H.265, ubah substream kamera menjadi H.264. Dukungan H.265 di browser/WebRTC tidak merata dan dapat memerlukan transcoding yang berat.

## Alur pembagian akses

1. Administrator menambahkan kamera.
2. Administrator membuat account dan memilih role.
3. Pada bagian **Pembagian kamera per role**, pilih role Viewer dan centang kamera yang boleh dilihat.
4. Account Viewer hanya menerima daftar dan URL player kamera yang telah diizinkan dari API.
5. Administrator dan Supervisor dapat melihat semua kamera berdasarkan flag `can_view_all`.

Untuk kebutuhan bidang yang berbeda, tambahkan role baru langsung di PostgreSQL pada MVP ini atau kembangkan endpoint CRUD role pada tahap berikutnya. Tabel `departments` sudah tersedia untuk pengelompokan organisasi.

## Rekomendasi jaringan dan performa

- Jalankan server dan kamera pada VLAN CCTV; izinkan client hanya menuju port dashboard/WebRTC yang diperlukan.
- Jangan membuka port kamera ke internet. Untuk akses luar, gunakan VPN.
- Gunakan akun kamera read-only khusus dashboard.
- Grid menggunakan substream 360p–720p, 5–15 fps, sekitar 0.5–1 Mbps.
- Satu Mini PC Intel N100 disarankan menampilkan 9–16 kamera bersamaan.
- `sourceOnDemand: true` mencegah server menarik semua stream saat tidak ada viewer.
- WebRTC membutuhkan TCP 8889 dan UDP 8189 antara client dan server.

## Database dan persiapan playback

Database aplikasi bernama `sentra_cctv`. Backend menggunakan role terbatas `sentra_cctv_app`, bukan superuser PostgreSQL. Skema awal juga menyediakan tabel `recordings` dengan relasi kamera, waktu mulai/selesai, lokasi file, ukuran, dan status.

PostgreSQL hanya menyimpan **metadata/index rekaman**, bukan file video. Untuk fitur playback, rekaman MediaMTX sebaiknya disimpan di volume disk Ubuntu atau object storage, kemudian proses indexing memasukkan setiap segmen ke tabel `recordings`. API dan UI playback belum termasuk pada tahap migrasi database ini.

## Backup

Backup PostgreSQL secara terjadwal menggunakan `pg_dump`, dan backup media rekaman secara terpisah. Contoh dari host yang memiliki PostgreSQL client:

```bash
pg_dump --format=custom --dbname="$DATABASE_URL" --file="sentra_cctv_$(date +%F).dump"
```

File `deploy/mediamtx.yml` mengandung credential kamera dan harus dibatasi hak aksesnya serta tidak dibagikan.

## Batasan MVP dan tahap berikutnya

- Belum ada CRUD role/bidang dari UI; role bawaan dan bidang Keamanan dibuat saat seed.
- Belum ada proxy otorisasi per request di depan MediaMTX. Karena targetnya LAN internal, URL player hanya diberikan setelah API memvalidasi role, tetapi user yang mengetahui URL MediaMTX dapat membukanya langsung. Untuk keamanan lebih ketat, tahap berikutnya perlu MediaMTX HTTP authentication/JWT atau reverse proxy berotorisasi.
- Status online/offline masih mengikuti respons player MediaMTX, belum ada ONVIF health polling.
- API/UI playback dan proses perekaman belum diimplementasikan; tabel metadata `recordings` sudah disiapkan sebagai fondasi tahap berikutnya.