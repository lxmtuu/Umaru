#!/usr/bin/env node
// Redis **giả** cho dev/QA: đủ cho những gì app dùng — pub/sub (`SUBSCRIBE`,
// `PUBLISH`) và các lệnh của session store (`HSET`, `HGETALL`, `PEXPIRE`,
// `DEL`, `RPUSH`, `LTRIM`, `LRANGE`).
//
// Vì sao có file này: sandbox dev không có Redis server, nhưng "chạy hai node có
// nói chuyện được với nhau không" và "resume qua node khác có đúng không" là câu
// hỏi phải trả lời bằng chạy thật, không phải bằng suy luận. Broker này nói RESP
// thật trên TCP nên `RedisBus`/`RedisClient` chạy y như với Redis — nó **không**
// kiểm được hành vi riêng của Redis (ACL, persist, cluster, TTL thật) và
// **không** dùng cho production.
//
//   node scripts/fake-redis.mjs 6390
//   REDIS_URL=redis://127.0.0.1:6390 GATEWAY_NODE_ID=api-2 PORT=4001 node dist/server.js
//   node scripts/multi-node-check.mjs

import net from "node:net";

const subscribers = new Set();
const hashes = new Map();
const lists = new Map();
const ttls = new Map();
const log = (...args) => console.log(new Date().toISOString(), ...args);

function normalizeIndex(index, length) {
  return index < 0 ? Math.max(0, length + index) : index;
}

const integer = (value) => `:${value}\r\n`;
const bulk = (value) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
function replyArray(values) {
  let out = `*${values.length}\r\n`;
  for (const value of values) out += typeof value === "number" ? integer(value) : bulk(value);
  return out;
}

function readCommand(buffer) {
  if (buffer[0] !== 0x2a) return null;
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd < 0) return null;
  const count = Number(buffer.subarray(1, headerEnd).toString("utf8"));
  let cursor = headerEnd + 2;
  const args = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer[cursor] !== 0x24) return null;
    const lengthEnd = buffer.indexOf("\r\n", cursor);
    if (lengthEnd < 0) return null;
    const length = Number(buffer.subarray(cursor + 1, lengthEnd).toString("utf8"));
    const start = lengthEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    args.push(buffer.subarray(start, end).toString("utf8"));
    cursor = end + 2;
  }
  return { args, next: cursor };
}

function handle(socket, args) {
  const name = (args[0] ?? "").toUpperCase();
  switch (name) {
    case "AUTH":
    case "SELECT":
    case "PING":
      socket.write("+OK\r\n");
      return;
    case "SUBSCRIBE": {
      const channel = args[1] ?? "";
      subscribers.add({ socket, channel });
      socket.write(replyArray(["subscribe", channel, 1]));
      log("subscribe", channel, "tổng:", subscribers.size);
      return;
    }
    case "PUBLISH": {
      const [channel, payload] = [args[1] ?? "", args[2] ?? ""];
      let delivered = 0;
      for (const subscriber of subscribers) {
        if (subscriber.channel !== channel) continue;
        subscriber.socket.write(replyArray(["message", channel, payload]));
        delivered += 1;
      }
      socket.write(integer(delivered));
      return;
    }
    case "HSET": {
      const key = args[1] ?? "";
      const hash = hashes.get(key) ?? new Map();
      for (let index = 2; index + 1 < args.length; index += 2) hash.set(args[index], args[index + 1]);
      hashes.set(key, hash);
      socket.write(integer(1));
      return;
    }
    case "HGETALL": {
      const hash = hashes.get(args[1] ?? "");
      const flat = [];
      if (hash !== undefined) for (const [field, value] of hash) flat.push(field, value);
      socket.write(replyArray(flat));
      return;
    }
    case "PEXPIRE":
    case "EXPIRE":
      ttls.set(args[1] ?? "", name === "EXPIRE" ? Number(args[2] ?? 0) * 1000 : Number(args[2] ?? 0));
      socket.write(integer(1));
      return;
    case "DEL": {
      let deleted = 0;
      for (const key of args.slice(1)) {
        if (hashes.delete(key)) deleted += 1;
        if (lists.delete(key)) deleted += 1;
        ttls.delete(key);
      }
      socket.write(integer(deleted));
      return;
    }
    case "RPUSH": {
      const key = args[1] ?? "";
      const list = lists.get(key) ?? [];
      list.push(...args.slice(2));
      lists.set(key, list);
      socket.write(integer(list.length));
      return;
    }
    case "LTRIM": {
      const key = args[1] ?? "";
      const list = lists.get(key) ?? [];
      const start = normalizeIndex(Number(args[2] ?? 0), list.length);
      const stop = normalizeIndex(Number(args[3] ?? -1), list.length);
      lists.set(key, stop < start ? [] : list.slice(start, stop + 1));
      socket.write("+OK\r\n");
      return;
    }
    case "LRANGE": {
      const list = lists.get(args[1] ?? "") ?? [];
      const start = normalizeIndex(Number(args[2] ?? 0), list.length);
      const stop = normalizeIndex(Number(args[3] ?? -1), list.length);
      socket.write(replyArray(stop < start ? [] : list.slice(start, stop + 1)));
      return;
    }
    default:
      socket.write(`-ERR lệnh không hỗ trợ: ${name}\r\n`);
  }
}

const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const parsed = readCommand(buffer);
      if (parsed === null) return;
      buffer = buffer.subarray(parsed.next);
      handle(socket, parsed.args);
    }
  });
  socket.on("close", () => {
    for (const subscriber of [...subscribers]) {
      if (subscriber.socket === socket) subscribers.delete(subscriber);
    }
  });
  socket.on("error", () => undefined);
});

const port = Number(process.argv[2] ?? "6390");
server.listen(port, "0.0.0.0", () => log(`broker ${port}`));
