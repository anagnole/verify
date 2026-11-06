import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import fs from "node:fs";

function allowList() {
  let raw = process.env.ALLOW ?? "";
  try {
    raw = fs.readFileSync("/tmp/allow", "utf8");
  } catch {}
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

const quiet = (process.env.QUIET ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

function isQuiet(host) {
  const name = host.toLowerCase().replace(/\.$/, "");
  return quiet.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

function isAllowed(host) {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allowList().some((allowed) => name === allowed || name.endsWith(`.${allowed}`));
}

function log(entry) {
  if (entry.action === "blocked" && entry.host && isQuiet(entry.host)) return;
  console.log(JSON.stringify({ t: Date.now(), ...entry }));
}

const proxy = http.createServer((request, response) => {
  let target;
  try {
    target = new URL(request.url);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!isAllowed(target.hostname)) {
    log({ kind: "http", host: target.hostname, action: "blocked" });
    response.writeHead(403).end("Blocked by verify");
    return;
  }
  log({ kind: "http", host: target.hostname, action: "allowed" });
  const upstream = http.request(target, { method: request.method, headers: request.headers }, (reply) => {
    response.writeHead(reply.statusCode ?? 502, reply.headers);
    reply.pipe(response);
  });
  upstream.on("error", () => response.destroy());
  request.pipe(upstream);
});

proxy.on("connect", (request, socket, head) => {
  const [host, port] = String(request.url).split(":");
  if (!isAllowed(host)) {
    log({ kind: "https", host, action: "blocked" });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  log({ kind: "https", host, action: "allowed" });
  const upstream = net.connect(Number(port) || 443, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

proxy.listen(3128);

function readQuestion(message) {
  const labels = [];
  let offset = 12;
  while (offset < message.length && message[offset] !== 0) {
    const length = message[offset];
    labels.push(message.subarray(offset + 1, offset + 1 + length).toString());
    offset += length + 1;
  }
  return { name: labels.join("."), end: offset + 5 };
}

const dns = dgram.createSocket("udp4");
dns.on("message", (message, remote) => {
  if (message.length < 12) return;
  const { name, end } = readQuestion(message);
  if (name) log({ kind: "dns", host: name, action: "blocked" });
  const reply = Buffer.from(message.subarray(0, end));
  reply[2] = 0x81;
  reply[3] = 0x83;
  reply.writeUInt16BE(0, 6);
  reply.writeUInt16BE(0, 8);
  reply.writeUInt16BE(0, 10);
  dns.send(reply, remote.port, remote.address);
});
dns.bind(53);

log({ kind: "ready", host: "", action: "allowed" });
