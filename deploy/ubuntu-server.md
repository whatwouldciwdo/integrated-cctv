# Deployment Sentra CCTV di Ubuntu Server

Panduan ini menggunakan topologi berikut:

- Ubuntu Server aplikasi dan MediaMTX: `10.8.140.67`
- PostgreSQL: `10.8.140.69:5432`
- Dashboard: `http://10.8.140.67:8080`
- MediaMTX WebRTC: `http://10.8.140.67:8889`
- Repository: `https://github.com/whatwouldciwdo/integrated-cctv.git`

Jalankan perintah berikut melalui SSH menggunakan account yang memiliki akses `sudo`.

## 1. Pastikan IP server benar

```bash
hostname -I
ip address
```

Pastikan interface LAN Ubuntu memiliki IP `10.8.140.67`. Sebaiknya gunakan static IP atau DHCP reservation agar URL dashboard dan WebRTC tidak berubah.

## 2. Install Git dan Docker

```bash
sudo apt update
sudo apt install -y git curl ca-certificates docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Keluar dari sesi SSH lalu masuk kembali agar membership group `docker` aktif. Verifikasi:

```bash
docker --version
docker compose version
docker run --rm hello-world
```

Jika paket `docker-compose-v2` tidak tersedia pada versi Ubuntu yang digunakan, install Docker Engine dan Compose plugin dari repository resmi Docker: <https://docs.docker.com/engine/install/ubuntu/>.

## 3. Clone source code dari GitHub

Untuk instalasi pertama:

```bash
sudo mkdir -p /opt/sentra-cctv
sudo chown "$USER":"$USER" /opt/sentra-cctv
git clone https://github.com/whatwouldciwdo/integrated-cctv.git /opt/sentra-cctv
cd /opt/sentra-cctv
git switch main
```

Periksa commit yang digunakan:

```bash
git status
git log -1 --oneline
```

## 4. Buat konfigurasi environment

Salin template. File `.env` diabaikan Git dan Docker build context, serta tidak boleh di-commit karena berisi password.

```bash
cd /opt/sentra-cctv
cp .env.example .env
nano .env
```

Sesuaikan minimal nilai berikut:

```env
PORT=8080
APP_ORIGIN=http://10.8.140.67:8080
DATABASE_URL=postgresql://sentra_cctv_app:GANTI_PASSWORD_DB@10.8.140.69:5432/sentra_cctv
DATABASE_POOL_MAX=10
DATABASE_SSL=false
SESSION_TTL_HOURS=12
ADMIN_USERNAME=admin
ADMIN_PASSWORD=GANTI_DENGAN_PASSWORD_ADMIN_YANG_PANJANG_DAN_UNIK
RTSP_ENCRYPTION_KEY=GANTI_DENGAN_KUNCI_32_BYTE_BASE64
SECURE_COOKIES=false
SERVER_LAN_IP=10.8.140.67
MEDIAMTX_WEBRTC_BASE=http://10.8.140.67:8889
```

Catatan:

- Ganti kedua placeholder password sebelum aplikasi dijalankan.
- Buat `RTSP_ENCRYPTION_KEY` satu kali dengan `openssl rand -base64 32`. Simpan salinannya di password manager/secret manager dan jangan menggantinya setelah kamera tersimpan; kehilangan key membuat RTSP Source URL lama tidak dapat didekripsi.
- Jika password database mengandung karakter khusus URL seperti `@`, `:`, `/`, `?`, atau `#`, lakukan URL encoding pada password tersebut.
- Gunakan `SECURE_COOKIES=true` hanya setelah dashboard dilayani melalui HTTPS.
- Batasi permission file environment dengan `chmod 600 .env`.

## 5. Uji koneksi jaringan ke PostgreSQL

```bash
timeout 5 bash -c '</dev/tcp/10.8.140.69/5432' \
  && echo 'PostgreSQL dapat dijangkau' \
  || echo 'PostgreSQL tidak dapat dijangkau'
```

Jika gagal, periksa routing/firewall dan pastikan PostgreSQL mengizinkan koneksi dari `10.8.140.67` pada `postgresql.conf`/`pg_hba.conf`.

## 6. Konfigurasi stream kamera

Untuk instalasi baru, jalankan service pada langkah 8 lalu tambahkan kamera melalui menu **Management**. Isi **Stream path** dan **RTSP Source URL**; backend mengenkripsi URL di PostgreSQL dan mengirim konfigurasi path ke Control API MediaMTX melalui network Docker internal. Credential tidak dikembalikan ke browser.

`deploy/mediamtx.yml` masih dapat dipakai untuk path statis lama. Edit file hanya bila memang menggunakan mode tersebut:

Edit konfigurasi MediaMTX:

```bash
nano deploy/mediamtx.yml
```

Contoh satu stream:

```yaml
paths:
  lobby-barat:
    source: rtsp://viewer:PASSWORD_KAMERA@192.168.10.30:554/substream
    sourceOnDemand: true
```

Nama path (`lobby-barat`) harus sama dengan **Stream path** yang dimasukkan melalui dashboard. Gunakan substream H.264 agar grid tetap ringan.

> `deploy/mediamtx.yml` dapat berisi credential kamera. Batasi akses dengan `chmod 600 deploy/mediamtx.yml` dan jangan push credential asli ke GitHub.

Konfigurasi statis ini disalin ke image MediaMTX ketika image dibangun. Pendekatan tersebut sengaja tidak memakai bind mount host sehingga tetap kompatibel ketika Docker tidak diizinkan me-mount direktori `/opt`. Setiap kali file statis diubah, build ulang MediaMTX:

```bash
docker compose up -d --build mediamtx
```

Kamera yang dikelola dashboard tidak memerlukan edit file atau rebuild. Dashboard menyinkronkan kembali seluruh path terenkripsi dari PostgreSQL setiap kali service dimulai.

## 7. Konfigurasi firewall Ubuntu

Pastikan SSH diizinkan sebelum mengaktifkan UFW agar akses remote tidak terputus:

```bash
sudo ufw allow OpenSSH
sudo ufw allow from 10.8.0.0/16 to any port 8080 proto tcp
sudo ufw allow from 10.8.0.0/16 to any port 8889 proto tcp
sudo ufw allow from 10.8.0.0/16 to any port 8189 proto udp
sudo ufw enable
sudo ufw status verbose
```

Port `8554/tcp` tidak perlu dibuka untuk client dashboard. Buka hanya jika perangkat lain memang perlu mengakses RTSP MediaMTX.

Sesuaikan subnet `10.8.0.0/16` jika jaringan client sebenarnya lebih sempit atau berbeda.

## 8. Build dan jalankan service

```bash
cd /opt/sentra-cctv
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Lihat log jika container belum sehat atau berhenti:

```bash
docker compose logs --tail=100 dashboard
docker compose logs --tail=100 mediamtx
```

Jika sebelumnya muncul error `error while creating mount source path '/opt/sentra-cctv/deploy/mediamtx.yml': ... read-only file system`, pastikan source code sudah berada pada commit terbaru lalu jalankan ulang perintah di atas. Compose versi terbaru membangun konfigurasi ke dalam image dan tidak lagi membuat bind mount tersebut.

## 9. Verifikasi deployment

Jalankan dari Ubuntu Server:

```bash
curl --fail http://localhost:8080/api/health
```

Respons yang diharapkan:

```json
{"ok":true,"database":"connected"}
```

Kemudian buka dari browser client:

```text
http://10.8.140.67:8080
```

Login menggunakan `ADMIN_USERNAME` dan `ADMIN_PASSWORD` dari `.env`, lalu segera gunakan password admin yang kuat.

## 10. Melakukan pull/update berikutnya

Sebelum pull, periksa perubahan lokal:

```bash
cd /opt/sentra-cctv
git status --short
```

File `.env` aman karena diabaikan Git. Jika `deploy/mediamtx.yml` telah diedit langsung dan muncul sebagai modified, selalu backup lalu pulihkan versi Git sebelum melakukan pull agar tidak terjadi konflik:

```bash
cp deploy/mediamtx.yml "$HOME/mediamtx.yml.backup"
git restore deploy/mediamtx.yml
```

Ambil update branch `main` tanpa membuat merge commit otomatis:

```bash
git pull --ff-only origin main
```

Jika backup hanya berisi path statis yang tetap ingin dikelola lewat YAML, kembalikan konfigurasi MediaMTX lokal setelah pull:

```bash
cp "$HOME/mediamtx.yml.backup" deploy/mediamtx.yml
```

Jika backup berisi path `wisenet-*` yang akan dipindahkan ke PostgreSQL, **jangan** jalankan perintah `cp` tersebut. Ikuti prosedur migrasi satu kali di bawah agar credential plaintext tidak dimasukkan kembali ke image.

Build ulang dan verifikasi:

```bash
docker compose up -d --build
docker compose ps
curl --fail http://localhost:8080/api/health
```

Bersihkan image Docker lama secara berkala setelah memastikan versi baru berjalan normal:

```bash
docker image prune -f
```

### Migrasi satu kali path Wisenet dari YAML ke PostgreSQL

Gunakan prosedur ini ketika memperbarui instalasi lama yang masih menyimpan path `wisenet-*` di `deploy/mediamtx.yml`. Backup **harus dibuat sebelum** `git restore`/`git pull`:

```bash
cd /opt/sentra-cctv
cp deploy/mediamtx.yml "$HOME/mediamtx-before-db-migration.yml"

# Tambahkan RTSP_ENCRYPTION_KEY ke .env sebelum menjalankan versi baru.
openssl rand -base64 32
nano .env

git restore deploy/mediamtx.yml
git pull --ff-only origin main
docker compose up -d --build

# Import hanya path berprefix wisenet- dari backup, lalu sinkronkan ke MediaMTX.
docker compose exec -T dashboard npm run import:wisenet \
  < "$HOME/mediamtx-before-db-migration.yml"
```

Importer menerima format YAML block maupun inline, mengenkripsi setiap RTSP Source URL, dan bersifat idempotent berdasarkan `stream_path`. Verifikasi tanpa menampilkan credential:

```bash
docker compose logs --tail=100 dashboard
curl --fail http://localhost:8080/api/health
```

Login sebagai Administrator, buka **Management**, pastikan semua kamera Wisenet berstatus **RTSP tersimpan**, lalu uji playback beberapa kamera. Simpan backup YAML lama secara aman sampai seluruh stream terverifikasi; file tersebut mengandung credential plaintext.

## 11. Perintah operasional

```bash
# Melihat status
docker compose ps

# Mengikuti semua log
docker compose logs -f

# Restart service
docker compose restart

# Menghentikan service
docker compose down

# Menjalankan kembali
docker compose up -d
```

Jangan gunakan `docker compose down -v` tanpa memahami dampaknya karena opsi `-v` menghapus volume yang dikelola Compose.