#!/usr/bin/env node
// Redis **giả** cho dev/QA: chỉ PUBLISH + SUBSCRIBE, đủ để thử đa node gateway
// mà không phải cài Redis.
//
// Vì sao có file này: sandbox dev không có Redis server, nhưng "chạy hai node có
// nói chuyện được với nhau không" là câu hỏi phải trả lời bằng chạy thật, không
// phải bằng suy luận. Broker này nói RESP thật trên TCP nên `RedisBus` của API
// chạy y như với Redis — nó **không** kiểm được hành vi riêng của Redis (ACL,
// persist, cluster) và không dùng cho production.
//
//   node scripts/fake-redis.mjs 6390
//   REDIS_URL=redis://127.0.0.1:6390 GATEWAY_NODE_ID=api-2 PORT=4001 node dist/server.js
//   node scripts/multi-node-check.mjs

import net from "node:net";

const subscribers = new Set();
const log = (...args) => console.log(new Date().toISOString(), ...args);

function readCommand(buf) {
  const text = buf.toString("utf8");
  if (!text.startsWith("*")) return null;
  const headerEnd = buf.indexOf("\r\n");
  if (headerEnd < 0) return null;
  const count = Number(text.slice(1, headerEnd));
  let cursor = headerEnd + 2;
  const args = [];
  for (let i = 0; i < count; i += 1) {
    const lengthEnd = buf.indexOf("\r\n", cursor);
    if (lengthEnd < 0) return null;
    const length = Number(buf.subarray(cursor + 1, lengthEnd).toString("utf8"));
    const start = lengthEnd + 2;
    const end = start + length;
    if (buf.length < end + 2) return null;
    args.push(buf.subarray(start, end).toString("utf8"));
    cursor = end + 2;
  }
  return { args, next: cursor };
}

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const parsed = readCommand(buffer);
      if (parsed === null) return;
      buffer = buffer.subarray(parsed.next);
      const [name, ...rest] = parsed.args;
      const cmd = (name ?? "").toUpperCase();
      if (cmd === "AUTH" || cmd === "SELECT") socket.write("+OK\r\n");
      else if (cmd === "SUBSCRIBE") {
        subscribers.add({ socket, channel: rest[0] });
        socket.write(`*3\r\n$9\r\nsubscribe\r\n$${Buffer.byteLength(rest[0])}\r\n${rest[0]}\r\n:1\r\n`);
        log("subscribe", rest[0], "tổng:", subscribers.size);
      } else if (cmd === "PUBLISH") {
        const [channel, payload] = rest;
        let delivered = 0;
        for (const sub of subscribers) {
          if (sub.channel !== channel) continue;
          sub.socket.write(`*3\r\n$7\r\nmessage\r\n$${Buffer.byteLength(channel)}\r\n${channel}\r\n$${Buffer.byteLength(payload)}\r\n${payload}\r\n`);
          delivered += 1;
        }
        socket.write(`:${delivered}\r\n`);
      } else socket.write("-ERR lệnh không hỗ trợ\r\n");
    }
  });
  socket.on("close", () => {
    for (const sub of [...subscribers]) if (sub.socket === socket) subscribers.delete(sub);
  });
  socket.on("error", () => undefined);
});
const port = Number(process.argv[2] ?? "6390");
server.listen(port, "0.0.0.0", () => log(`broker ${port}`));
