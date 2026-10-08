# 📦 NAS Drive

Aplikasi file manager berbasis web untuk jaringan lokal (LAN).
Diakses lewat browser dari PC, HP, atau tablet manapun di jaringan yang sama.

## ⚡ Cara Install & Jalankan

### Syarat
- [Node.js](https://nodejs.org) versi 16 ke atas

### Langkah

1. Extract folder ini ke lokasi yang diinginkan, contoh: `C:\NAS`

2. Buka **Command Prompt** atau **PowerShell** di dalam folder:
   ```
   cd C:\NAS
   ```

3. Install dependencies (cukup sekali):
   ```
   npm install
   ```

4. Jalankan server:
   ```
   node server.js
   ```

5. Buka browser: `http://localhost:3000`

6. Dari perangkat lain di jaringan, akses lewat IP yang muncul di console:
   ```
   http://192.168.x.x:3000
   ```

## ⚙️ Konfigurasi

Edit bagian ini di `server.js` untuk mengubah folder storage:

```js
// Ganti path ini sesuai kebutuhan
const STORAGE_ROOT = path.join(__dirname, 'storage');

// Contoh custom path:
// const STORAGE_ROOT = 'D:\\Files\\NAS';
// const STORAGE_ROOT = 'E:\\SharedFolder';
```

Untuk ganti port (default 3000):
```js
const PORT = 3000; // ganti ke port lain misal 8080
```

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

## 🚀 Autostart saat Windows booting (opsional)

1. Install pm2:
   ```
   npm install -g pm2
   npm install -g pm2-windows-startup
   ```

2. Jalankan dengan pm2:
   ```
   pm2 start server.js --name nas-drive
   pm2-startup install
   pm2 save
   ```

## 🔒 Keamanan

Aplikasi ini **tidak ada autentikasi** — cocok untuk jaringan rumah/kantor yang sudah trusted.
Kalau butuh password, bisa ditambahkan basic auth di server.js.
