// Self-test Pan VlessRelay: membuktikan relay benar-benar bekerja tanpa internet.
//
//   node test/selftest.mjs
//
// Yang diuji:
//   1. health probe (dipakai HEALTHCHECK Docker) menjawab "OK" untuk rahasia yang benar
//   2. datagram dari "worker" (klien TCP) diteruskan ke UDP dan balasannya kembali utuh
//   3. rahasia salah ditolak TANPA ada datagram yang dikirim ke tujuan (relay tidak boleh
//      jadi alat refleksi UDP untuk siapa pun)
//   4. dua datagram berturut-turut pada satu sesi dijawab dua kali (sesi dipakai ulang)
//
// Keluar dengan kode 1 kalau ada yang gagal.
import net from "node:net";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RELAY_PORT = Number(process.env.RELAY_PORT || 7391);
const RELAY_HOST = process.env.RELAY_HOST_TEST || "127.0.0.1";
const ECHO_PORT = 7392;
// ECHO_BIND: alamat bind UDP echo di mesin ini. ECHO_HOST: alamat yang ditulis di header relay
// (jadi alamat mesin ini seperti terlihat dari relay) — beda kalau relay di mesin lain.
const ECHO_BIND = process.env.ECHO_BIND || "127.0.0.1";
const ECHO_HOST = process.env.ECHO_HOST || "127.0.0.1";
const SECRET = process.env.RELAY_SECRET || "rahasia-uji-selftest";
// RELAY_EXTERNAL=1: jangan jalankan relay sendiri, uji relay yang sudah jalan di host:port
// (mis. container Docker atau VPS). Rahasia diambil dari RELAY_SECRET.
// Catatan: UDP echo-nya berjalan di mesin ini dan relay diminta mengirim ke 127.0.0.1:<echo>,
// jadi relay harus melihat "127.0.0.1" yang sama — untuk container pakai `--network host`.
const EXTERNAL = process.env.RELAY_EXTERNAL === "1";
const results = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listenUdpEcho() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.on("error", reject);
    sock.on("message", (msg, from) => {
      sock.send(Buffer.concat([Buffer.from("UDP:"), msg]), from.port, from.address);
    });
    sock.bind(ECHO_PORT, ECHO_BIND, () => resolve(sock));
  });
}

function startRelay() {
  const child = spawn(process.execPath, [path.join(ROOT, "relay", "udp-relay.mjs")], {
    env: { ...process.env, RELAY_HOST: "127.0.0.1", RELAY_PORT: String(RELAY_PORT), RELAY_SECRET: SECRET, RELAY_IDLE_MS: "4000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  return { child, getOut: () => out };
}

function waitPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const attempt = () => {
      const sock = net.connect(port, RELAY_HOST);
      sock.on("connect", () => { sock.destroy(); resolve(true); });
      sock.on("error", () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

// Klien = "worker": sambung TCP, kirim header, lalu frame [2B panjang][payload].
function openSession(secret, target = ECHO_HOST, port = ECHO_PORT) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(RELAY_PORT, RELAY_HOST);
    const frames = [];
    let closed = false;
    let leftover = Buffer.alloc(0);
    sock.on("connect", () => {
      // Header HARUS terkirim lebih dulu; resolve setelah itu supaya pemanggil tidak
      // mengirim datagram sebelum header (kalau tertukar, relay menolak sesinya).
      sock.write(`udp ${target} ${port} ${secret}\n`, () => {
        resolve({
          sock,
          frames: () => frames,
          isClosed: () => closed,
          send: (payload) => {
            const head = Buffer.alloc(2);
            head.writeUInt16BE(payload.length, 0);
            sock.write(Buffer.concat([head, payload]));
          },
        });
      });
    });
    sock.on("data", (chunk) => {
      leftover = Buffer.concat([leftover, chunk]);
      while (leftover.length >= 2) {
        const length = leftover.readUInt16BE(0);
        if (leftover.length < 2 + length) break;
        frames.push(leftover.subarray(2, 2 + length));
        leftover = leftover.subarray(2 + length);
      }
    });
    sock.on("close", () => { closed = true; });
    sock.on("error", () => {});
  });
}

function frame(payload) {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(payload.length, 0);
  return Buffer.concat([head, payload]);
}

async function until(fn, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
}

async function scenarioHealth() {
  const line = await new Promise((resolve) => {
    const sock = net.connect(RELAY_PORT, RELAY_HOST);
    let data = "";
    sock.on("connect", () => sock.write(`health ${SECRET}\n`));
    sock.on("data", (d) => { data += d.toString(); });
    sock.on("close", () => resolve(data.trim()));
    sock.on("error", () => resolve(""));
    setTimeout(() => { try { sock.destroy(); } catch (e) {} resolve(data.trim()); }, 3000);
  });
  return { name: "health probe menjawab OK", pass: line === "OK", detail: `balasan=${JSON.stringify(line)}` };
}

async function scenarioRoundTrip() {
  const session = await openSession(SECRET);
  session.send(Buffer.from("HALO-1"));
  await until(() => session.frames().length >= 1, 5000);
  session.send(Buffer.from("HALO-2"));
  await until(() => session.frames().length >= 2, 5000);
  const frames = session.frames();
  const first = frames[0] ? frames[0].toString("utf8") : "";
  const second = frames[1] ? frames[1].toString("utf8") : "";
  try { session.sock.destroy(); } catch (e) {}
  return {
    name: "datagram bolak-balik lewat relay (dua kali, satu sesi)",
    pass: first === "UDP:HALO-1" && second === "UDP:HALO-2",
    detail: `pertama=${JSON.stringify(first)} kedua=${JSON.stringify(second)} jumlah=${frames.length}`,
  };
}

async function scenarioWrongSecret(echoCount) {
  const before = echoCount();
  const session = await openSession("rahasia-salah");
  session.send(Buffer.from("JANGAN-KIRIM"));
  const closed = await until(() => session.isClosed(), 4000);
  await sleep(400);
  const after = echoCount();
  try { session.sock.destroy(); } catch (e) {}
  return {
    name: "rahasia salah ditolak tanpa mengirim datagram",
    pass: closed && after === before,
    detail: `tertutup=${closed} datagramKeEcho=${after - before}`,
  };
}

const stubs = [];
let relay = null;

try {
  let echoCount = 0;
  const echo = await listenUdpEcho();
  echo.on("message", () => { echoCount++; });
  stubs.push(echo);

  relay = EXTERNAL ? null : startRelay();
  if (!(await waitPort(RELAY_PORT, 10000))) {
    throw new Error("relay tidak siap di port " + RELAY_PORT + (relay ? "\n" + relay.getOut().slice(-500) : ""));
  }
  console.log(
    (EXTERNAL ? "menguji relay eksternal" : "menjalankan relay lokal") + " di 127.0.0.1:" + RELAY_PORT +
    " (protokol v1)\n"
  );

  results.push(await scenarioHealth());
  results.push(await scenarioRoundTrip());
  results.push(await scenarioWrongSecret(() => echoCount));
} catch (err) {
  results.push({ name: "setup", pass: false, detail: err.message });
} finally {
  if (relay) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(relay.child.pid), "/T", "/F"]);
      else relay.child.kill("SIGKILL");
    } catch (e) {}
  }
  for (const stub of stubs) {
    try { stub.close(); } catch (e) {}
  }
}

let failed = 0;
for (const result of results) {
  if (!result.pass) failed++;
  console.log(`[${result.pass ? "PASS" : "FAIL"}] ${result.name}\n    ${result.detail}`);
}
console.log(failed === 0 ? "\nSEMUA SKENARIO PASS" : `\n${failed} skenario GAGAL`);
process.exit(failed === 0 ? 0 : 1);
