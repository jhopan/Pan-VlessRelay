# Pan VlessRelay

Relay **TCP → UDP** untuk worker VLESS di [CFVPN Hub](../cfvpn-hub). Worker Cloudflare tidak
punya UDP keluar, jadi datagram UDP non-DNS (QUIC/HTTP3, WireGuard, game, NTP, …) diteruskan
worker ke relay ini lewat TCP, dan relay inilah yang mengirim UDP nyata ke tujuan.

DNS **tidak** lewat sini: worker menjawab port 53 sendiri lewat DoH, lebih cepat.

## Isi repo

| Path | Isi |
|---|---|
| `relay/udp-relay.mjs` | Server relay (tanpa dependensi npm) |
| `Dockerfile` | Image `node:22-alpine`, non-root, healthcheck lewat protokol relay |
| `docker-compose.yml` | Jalankan + restart + pengerasan (read-only, `cap_drop`, `no-new-privileges`) |
| `.env.example` | Semua variabel lingkungan |
| `test/selftest.mjs` | Uji mandiri: health probe, bolak-balik datagram, penolakan rahasia salah |

## Jalankan dengan Docker

```bash
cp .env.example .env
# isi RELAY_SECRET dengan nilai acak panjang, mis. openssl rand -hex 32

# kalau ada plugin compose:
docker compose up -d --build

# kalau docker-nya paket Debian (tanpa `docker compose`):
docker build -t pan-vless-relay .
docker run -d --name pan-vless-relay -p 7300:7300/tcp \
  -e RELAY_SECRET="$(grep ^RELAY_SECRET .env | cut -d= -f2)" \
  --restart unless-stopped pan-vless-relay
```

Cek:

```bash
docker logs -f pan-vless-relay          # "Pan VlessRelay siap di 0.0.0.0:7300 | protokol 1"
docker inspect --format '{{.State.Health.Status}}' pan-vless-relay   # healthy
```

Yang dibuka di firewall: **TCP 7300** (worker → relay). UDP hanya keluar dari relay, tidak
ada port UDP yang perlu dibuka.

## Tanpa Docker

```bash
RELAY_SECRET="rahasia-panjang" node relay/udp-relay.mjs
```

Contoh unit systemd:

```ini
[Unit]
Description=Pan VlessRelay (UDP relay untuk CFVPN Hub)
After=network-online.target
Wants=network-online.target

[Service]
Environment=RELAY_SECRET=ganti-dengan-rahasia-panjang
Environment=RELAY_PORT=7300
ExecStart=/usr/bin/node /opt/pan-vless-relay/relay/udp-relay.mjs
Restart=always
RestartSec=3
User=nobody
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## Menyambungkan dari worker VLESS (CFVPN Hub)

Set binding env pada worker:

| Binding worker | Contoh | Arti |
|---|---|---|
| `RELAY_SERVER_UDP` | `relay.domainmu.com` | host relay; kosong = UDP non-DNS ditutup cepat (perilaku lama) |
| `RELAY_SERVER_PORT` | `7300` | port relay |
| `RELAY_SERVER_TLS` | `1` | relay memakai TLS (lihat bagian TLS) |
| `RELAY_SECRET` | sama dengan relay | wajib sama |

Selama salah satu belum diisi, worker berjalan seperti sebelumnya (tanpa UDP relay).

## Protokol (versi 1)

Satu koneksi TCP = satu sesi UDP ke **satu** tujuan.

```
klien -> relay : "udp <alamat> <port> <rahasia>\n"     (sekali di awal)
dua arah       : [2B panjang BE][payload]              (satu datagram per frame)
klien -> relay : "health <rahasia>\n"  ->  "OK\n"      (healthcheck, lalu relay menutup)
```

Sesi ditutup kalau: klien menutup, rahasia salah, atau tidak ada trafik selama `RELAY_IDLE_MS`.
Versi protokol ditulis di log saat start; kalau berubah, sisi worker di `cfvpn-hub` harus ikut
diubah.

## TLS (opsional)

Relay bisa dibungkus TLS kalau jaringan memaksa port 443:

```bash
docker run -d --name pan-vless-relay -p 443:8443/tcp \
  -e RELAY_SECRET=... -e RELAY_TLS=1 -e RELAY_PORT=8443 \
  -e RELAY_CERT=/certs/fullchain.pem -e RELAY_KEY=/certs/privkey.pem \
  -v /etc/letsencrypt/live/relay.domainmu.com:/certs:ro \
  pan-vless-relay
```

Lalu di worker: `RELAY_SERVER_TLS=1` + `RELAY_SERVER_PORT=443`.

## Keamanan (baca ini)

- `RELAY_SECRET` **wajib**. Tanpa itu proses menolak start — relay terbuka bisa dipakai orang
  lain untuk refleksi/amplifikasi UDP.
- Relay hanya mengirim ke tujuan yang diminta worker, jadi jaga kerahasiaan token dan jangan
  bagikan host relay ke publik.
- Batasi ukuran datagram (`RELAY_MAX_DATAGRAM`) dan, kalau perlu, batasi di firewall siapa saja
  yang boleh menyambung ke TCP 7300 (mis. hanya alamat egress Cloudflare) — relay tidak bisa
  membedakan worker yang sah selain lewat rahasia.

## Batas yang perlu diketahui

- **Satu hop tambahan**: latensi naik sekitar RTT worker → relay.
- **UDP di atas TCP**: untuk QUIC kinerjanya turun (TCP menganggap paket hilang sebagai
  kongesti). Protokol UDP kecil tetap enak; streaming QUIC berat tidak disarankan.
- Relay **tidak** menangani TCP dan **tidak** menangani DNS — keduanya sudah ditangani worker.

## Uji mandiri

```bash
node test/selftest.mjs      # offline: tidak butuh internet
```
