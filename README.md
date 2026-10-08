# 📦 NAS Drive

Aplikasi file manager + papan tulis bersama berbasis web untuk jaringan lokal (LAN).
Diakses lewat browser dari PC, HP, atau tablet manapun di jaringan yang sama.

## 🔥 Fitur

- Browse folder & subfolder
- Upload file (multi-file, drag & drop)
- Download file
- Copy / cut / paste file & folder (tombol 📋/✂, shortcut Ctrl+C/X/V)
- 📝 Papan tulis bersama (realtime via WebSocket: multi-board, sinkron ketikan, presence)
- Preview gambar, video, PDF, teks/kode
- Buat folder baru
- Hapus & rename file/folder
- Tampilan Grid / List
- Search file
- Streaming video (range request)
- Akses dari semua device di LAN

## 🐧 Install di Ubuntu Server

### 1. Syarat

- Ubuntu 20.04 / 22.04 / 24.04
- [Node.js](https://nodejs.org) versi 18 ke atas (disarankan 22 LTS)

### 2. Install Node.js (kalau belum ada)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v  # pastikan v22.x
```

### 3. Clone repo & install dependencies

```bash
sudo apt install -y git
git clone https://github.com/adri-cry/nas-drive.git /opt/nas-drive
cd /opt/nas-drive
npm install --omit=dev
```

> Folder `storage/` (file user) dan `boards/` (papan tulis) dibuat otomatis
> saat server pertama kali jalan. Isinya tidak ikut ke Git.

### 4. Coba jalankan manual

```bash
node server.js
```

Buka `http://IP-SERVER:3000` dari browser. Kalau tampil, hentikan dengan `Ctrl+C`
dan lanjut ke systemd supaya jalan permanen.

### 5. Jalan permanen dengan systemd (autostart saat boot)

Buat file service:

```bash
sudo nano /etc/systemd/system/nas-drive.service
```

Isi:

```ini
[Unit]
Description=NAS Drive
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/nas-drive
ExecStart=/usr/bin/node /opt/nas-drive/server.js
Restart=on-failure
RestartSec=5
# Pastikan user service bisa tulis storage & boards:
# sudo chown -R www-data:www-data /opt/nas-drive

[Install]
WantedBy=multi-user.target
```

Aktifkan:

```bash
sudo chown -R www-data:www-data /opt/nas-drive
sudo systemctl daemon-reload
sudo systemctl enable --now nas-drive
systemctl status nas-drive
```

### 6. Buka firewall (kalau pakai UFW)

```bash
sudo ufw allow 3000/tcp
sudo ufw reload
```

Akses dari perangkat lain di jaringan yang sama:

```
http://192.168.x.x:3000
```

(IP server-nya tampil di log: `journalctl -u nas-drive -f`)

### 7. Update ke versi terbaru

```bash
cd /opt/nas-drive
git pull
npm install --omit=dev
sudo systemctl restart nas-drive
```

## 🪟 Install di Windows (alternatif)

1. Install [Node.js](https://nodejs.org) versi 18+,
   lalu clone atau download ZIP repo ini, contoh ke `C:\NAS`.
2. Buka PowerShell di dalam folder:
   ```
   cd C:\NAS
   npm install
   node server.js
   ```
3. Buka `http://localhost:3000`. Dari perangkat lain pakai IP yang muncul di console.
4. Autostart opsional dengan pm2:
   ```
   npm install -g pm2
   npm install -g pm2-windows-startup
   pm2 start server.js --name nas-drive
   pm2-startup install
   pm2 save
   ```

## ⚙️ Konfigurasi

Edit di `server.js` untuk mengubah folder storage:

```js
// Ganti path ini sesuai kebutuhan
const STORAGE_ROOT = path.join(__dirname, 'storage');

// Contoh custom path di Linux:
// const STORAGE_ROOT = '/mnt/data/nas';
// Contoh di Windows:
// const STORAGE_ROOT = 'D:\\Files\\NAS';
```

Untuk ganti port (default 3000):

```js
const PORT = 3000; // ganti ke port lain misal 8080
```

> Kalau port diganti, sesuaikan juga aturan firewall/UFW dan restart service.

## 🔒 Keamanan

Aplikasi ini **tidak ada autentikasi** — cocok untuk jaringan rumah/kantor yang sudah trusted.
Jangan expose langsung ke internet tanpa reverse proxy + password.
Kalau butuh password, bisa ditambahkan basic auth di `server.js`.
