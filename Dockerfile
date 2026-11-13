# Pan VlessRelay — UDP relay untuk worker VLESS (CFVPN Hub)
#
# Worker Cloudflare tidak punya UDP keluar, jadi datagram UDP non-DNS diteruskan ke proses
# ini lewat TCP; relay inilah yang mengirim UDP nyata ke tujuan.
#
#   docker build -t pan-vless-relay .
#   docker run -d --name pan-vless-relay -p 7300:7300/tcp \
#     -e RELAY_SECRET="rahasia-panjang" --restart unless-stopped pan-vless-relay
#
# Perhatikan: yang diekspos adalah TCP (worker -> relay). UDP hanya keluar dari relay.

FROM node:22-alpine

ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=7300 \
    RELAY_IDLE_MS=60000 \
    RELAY_MAX_DATAGRAM=8192

WORKDIR /app

# Hanya relay yang dibutuhkan di image; tidak ada dependensi npm.
COPY relay/udp-relay.mjs ./relay/udp-relay.mjs

USER node

# Healthcheck memakai protokol relay sendiri ("health <rahasia>" -> "OK"), jadi tidak perlu
# port tambahan. Dijalankan sebagai node one-liner supaya image tidak butuh curl/netcat.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "const n=require('net');const s=n.connect(Number(process.env.RELAY_PORT||7300),'127.0.0.1',()=>s.write('health '+process.env.RELAY_SECRET+'\n'));s.on('data',d=>{process.exit(d.toString().trim()==='OK'?0:1)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000);"

EXPOSE 7300/tcp

ENTRYPOINT ["node", "relay/udp-relay.mjs"]
