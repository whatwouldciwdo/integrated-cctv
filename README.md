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

Backend **tidak pernah mengirim RTSP URL atau password kamera ke browser**. Kamera yang dibuat atau diedit dari dashboard menyimpan RTSP Source URL dalam bentuk terenkripsi AES-256-GCM di PostgreSQL. Kunci enkripsi hanya berada di environment server, sedangkan MediaMTX menerima konfigurasi path melalui Control API pada network Docker internal.

## Fitur MVP

- Session login menggunakan cookie HttpOnly dan token yang di-hash di database
- Password disimpan menggunakan `scrypt` dengan salt acak
- Role bawaan: Administrator, Supervisor, Viewer
- Pembagian kamera many-to-many berdasarkan role
- Management user dan kamera
- Management RTSP Source URL kamera langsung dari dashboard tanpa edit YAML/rebuild
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

Server Ubuntu aplikasi menggunakan IP **`10.8.140.67`**, sedangkan PostgreSQL tetap berada di **`10.8.140.69`**.

Panduan lengkap untuk instalasi Docker, clone/pull source code, konfigurasi `.env`, firewall, menjalankan service, dan proses update berikutnya tersedia di **[Panduan Deployment Ubuntu](deploy/ubuntu-server.md)**.

Ringkasan deployment:

1. Siapkan Ubuntu Server `10.8.140.67` dengan Docker Engine dan plugin Docker Compose.
2. Clone project ke server, lalu salin `.env.example` menjadi `.env`. Untuk akses HTTP biasa di jaringan kantor, biarkan `SECURE_COOKIES=false`; jika sudah memakai HTTPS, ubah menjadi `true`.
3. Buat kunci enkripsi satu kali dengan `openssl rand -base64 32`, lalu isi koneksi PostgreSQL, password admin yang kuat, IP LAN server, dan kunci tersebut:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ganti-dengan-password-panjang
RTSP_ENCRYPTION_KEY=hasil-openssl-rand-base64-32
APP_ORIGIN=http://10.8.140.67:8080
SERVER_LAN_IP=10.8.140.67
MEDIAMTX_WEBRTC_BASE=http://10.8.140.67:8889
DATABASE_URL=postgresql://sentra_cctv_app:password@10.8.140.69:5432/sentra_cctv
DATABASE_SSL=false
```

4. Untuk instalasi baru, tambahkan kamera dari menu **Management** dan isi RTSP Source URL. Path statis di `deploy/mediamtx.yml` tetap didukung untuk kamera lama yang belum dimigrasikan.
5. Jalankan:

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:8080/api/health
```

Konfigurasi dasar MediaMTX disalin ke image saat proses build, bukan di-bind mount dari host. Kamera yang dikelola dashboard tidak memerlukan rebuild MediaMTX; konfigurasi aktif dipulihkan otomatis dari PostgreSQL ketika dashboard restart.

6. Jika health check menghasilkan `{"ok":true,"database":"connected"}`, buka `http://10.8.140.67:8080` dari Mini PC client.

Database dan tabel dibuat otomatis ketika dashboard pertama kali berjalan. Jangan commit `.env` karena berisi password database dan admin.

## Menambahkan kamera

Di menu **Management → Tambah kamera**, isi nama, lokasi, brand, stream path, dan RTSP Source URL. Contoh:

```text
Stream path: lobby-barat
RTSP Source URL: rtsp://viewer:password@192.168.10.30:554/substream
```

RTSP Source URL dienkripsi sebelum disimpan. Sesudah tersimpan, UI hanya menampilkan status **Tersimpan** dan tidak mengembalikan credential ke browser. Biarkan field RTSP kosong ketika mengedit metadata jika URL lama tidak ingin diubah.

Contoh Wisenet/Hanwha yang mengizinkan RTSP tanpa autentikasi:

```text
Stream path: wisenet-01
RTSP Source URL: rtsp://192.168.141.111:554/profile2/media.smp
```

Untuk Wisenet yang masih meminta login, gunakan format
`rtsp://username:password@192.168.141.111:554/profile2/media.smp`. Profile 2 biasanya
merupakan substream dan lebih sesuai untuk grid dashboard.

`RTSP_ENCRYPTION_KEY` wajib berupa 32 byte base64 dan harus dibackup di password manager/secret manager. Jangan mengganti atau kehilangan key setelah data kamera tersimpan karena RTSP Source URL lama tidak akan dapat didekripsi.

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

File `deploy/mediamtx.yml` dapat mengandung credential kamera statis yang belum dimigrasikan dan harus dibatasi hak aksesnya serta tidak dibagikan. File `.env` dan backup-nya juga sensitif karena mengandung `RTSP_ENCRYPTION_KEY`.

## Batasan MVP dan tahap berikutnya

- Belum ada CRUD role/bidang dari UI; role bawaan dan bidang Keamanan dibuat saat seed.
- Belum ada proxy otorisasi per request di depan MediaMTX. Karena targetnya LAN internal, URL player hanya diberikan setelah API memvalidasi role, tetapi user yang mengetahui URL MediaMTX dapat membukanya langsung. Control API tidak dipublish ke host dan hanya digunakan dashboard melalui network Docker internal. Untuk keamanan playback lebih ketat, tahap berikutnya perlu MediaMTX HTTP authentication/JWT atau reverse proxy berotorisasi.
- Status online/offline masih mengikuti respons player MediaMTX, belum ada ONVIF health polling.
- API/UI playback dan proses perekaman belum diimplementasikan; tabel metadata `recordings` sudah disiapkan sebagai fondasi tahap berikutnya.