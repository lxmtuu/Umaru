#!/usr/bin/env node
// Kiểm chứng **đa node** đầu-cuối: hai tiến trình API, hai người dùng, hai kết nối
// WebSocket — tin nhắn/typing/presence phải đi qua bus, không qua DB polling.
//
// Vì sao có file này: test tự động (`services/api/test/gateway-cluster.test.ts`)
// dựng hai `buildApp()` trong **cùng một tiến trình**, nên nó chứng minh logic
// nhưng không chứng minh "hai tiến trình thật + một Redis thật nói chuyện được".
// Script này làm phần còn lại, và in ra bằng chứng từng bước.
//
// Dùng:
//   scripts/dev-pg.sh up                                  # Postgres dev
//   node scripts/fake-redis.mjs 6390                      # hoặc Redis thật
//   # node 1 (mặc định trong repo là cổng 4000)
//   REDIS_URL=redis://127.0.0.1:6390 GATEWAY_NODE_ID=api-1 PORT=4000 node dist/server.js
//   # node 2
//   REDIS_URL=redis://127.0.0.1:6390 GATEWAY_NODE_ID=api-2 PORT=4001 node dist/server.js
//   node scripts/multi-node-check.mjs
//
// Không chạy trong CI: CI không có hai tiến trình + bus. Dùng WebSocket có sẵn
// của Node (≥22) để không phải import `ws` từ workspace con.

const NODE_A = process.env.NODE_A_URL ?? "http://127.0.0.1:4000";
const NODE_B = process.env.NODE_B_URL ?? "http://127.0.0.1:4001";
const WS_A = NODE_A.replace(/^http/, "ws") + "/api/v1/gateway/ws";
const WS_B = NODE_B.replace(/^http/, "ws") + "/api/v1/gateway/ws";
const tag = String(Date.now()).slice(-7);

let failures = 0;
function check(label, ok, detail = "") {
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

async function api(base, method, path, { token, body } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    /* không phải JSON thì để nguyên text cho thông báo lỗi */
  }
  return { status: response.status, body: parsed, text };
}

async function register(username) {
  const response = await api(NODE_A, "POST", "/api/v1/auth/register", {
    body: {
      username,
      displayName: username,
      email: `${username}@example.com`,
      password: "mat-khau-123",
      acceptedTerms: true,
    },
  });
  if (response.status !== 201) throw new Error(`đăng ký ${username}: ${response.status} ${response.text}`);
  return { id: response.body.user.id, token: response.body.accessToken };
}

/** Mở WebSocket tới một node, gom frame, chờ theo điều kiện. */
function connect(url) {
  const socket = new WebSocket(url);
  const frames = [];
  const waiters = [];
  let lastSeq = 0;
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (typeof frame.s === "number" && frame.s > lastSeq) lastSeq = frame.s;
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(frame);
    else frames.push(frame);
  });
  const next = (predicate, timeoutMs = 5_000) =>
    new Promise((resolve, reject) => {
      const queued = frames.findIndex(predicate);
      if (queued >= 0) return resolve(frames.splice(queued, 1)[0]);
      const timer = setTimeout(() => reject(new Error("hết giờ chờ frame")), timeoutMs);
      waiters.push({ predicate, resolve: (frame) => (clearTimeout(timer), resolve(frame)) });
    });
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve({ socket, next, lastSeq: () => lastSeq }));
    socket.addEventListener("error", () => reject(new Error(`không nối được ${url}`)));
  });
}

const alice = await register(`mnA${tag}`);
const bob = await register(`mnB${tag}`);

const guild = await api(NODE_A, "POST", "/api/v1/guilds", {
  token: alice.token,
  body: { name: `Multi-node ${tag}` },
});
const channels = await api(NODE_A, "GET", `/api/v1/guilds/${guild.body.id}/channels`, { token: alice.token });
const channelId = channels.body[0].id;
const invite = await api(NODE_A, "POST", `/api/v1/guilds/${guild.body.id}/invites`, {
  token: alice.token,
  body: { channelId },
});
await api(NODE_A, "POST", `/api/v1/invites/${invite.body.code}`, { token: bob.token });

// Alice ở node 1, Bob ở node 2 — hai tiến trình khác nhau.
const a = await connect(WS_A);
a.socket.send(JSON.stringify({ op: 2, d: { token: alice.token } }));
const readyA = await a.next((frame) => frame.t === "READY");

const b = await connect(WS_B);
b.socket.send(JSON.stringify({ op: 2, d: { token: bob.token } }));
const ready = await b.next((frame) => frame.t === "READY");
check(
  "READY của Bob (node 2) thấy Alice đang online ở node 1",
  (ready.d.presences ?? []).some((entry) => entry.userId === alice.id),
  JSON.stringify(ready.d.presences ?? []),
);

const forward = await api(NODE_A, "POST", `/api/v1/channels/${channelId}/messages`, {
  token: alice.token,
  body: { content: "node 1 → node 2" },
});
check("gửi tin ở node 1 trả 201", forward.status === 201, String(forward.status));
const atB = await b.next((frame) => frame.t === "MESSAGE_CREATE" && frame.d.id === forward.body.id);
check("Bob ở node 2 nhận tin (qua bus)", atB.d.content === "node 1 → node 2");

const backward = await api(NODE_B, "POST", `/api/v1/channels/${channelId}/messages`, {
  token: bob.token,
  body: { content: "node 2 → node 1" },
});
check("gửi tin ở node 2 trả 201", backward.status === 201, String(backward.status));
const atA = await a.next((frame) => frame.t === "MESSAGE_CREATE" && frame.d.id === backward.body.id);
check("Alice ở node 1 nhận tin (qua bus)", atA.d.content === "node 2 → node 1");

await api(NODE_A, "POST", `/api/v1/channels/${channelId}/typing`, { token: alice.token });
const typing = await b.next((frame) => frame.t === "TYPING_START");
check("TYPING_START đi qua bus", typing.d.userId === alice.id && typing.d.channelId === channelId);

a.socket.send(JSON.stringify({ op: 3, d: { status: "idle" } }));
const presence = await b.next((frame) => frame.t === "PRESENCE_UPDATE" && frame.d.userId === alice.id);
check("PRESENCE_UPDATE đi qua bus", presence.d.status === "idle");

// ---------------------------------------------------------------------------
// Resume qua node: đóng socket ở node 1, nhận tin trong lúc offline, rồi
// reconnect thẳng vào node 2 — phải nhận đúng tin đã lỡ (session + replay nằm
// trong Redis dùng chung, không phải RAM của node 1).
// ---------------------------------------------------------------------------
const sessionId = readyA.d.sessionId;
const lastSeq = a.lastSeq();
a.socket.close();
await new Promise((resolve) => setTimeout(resolve, 300));

const missed = await api(NODE_A, "POST", `/api/v1/channels/${channelId}/messages`, {
  token: alice.token,
  body: { content: "gửi khi Alice offline" },
});
check("gửi tin trong lúc Alice offline", missed.status === 201, String(missed.status));

const resumed = await connect(WS_B);
resumed.socket.send(JSON.stringify({ op: 6, d: { token: alice.token, sessionId, seq: lastSeq } }));
const replayed = await resumed.next((frame) => frame.t === "MESSAGE_CREATE");
check(
  "resume ở node 2 nhận đúng tin đã lỡ (không full resync)",
  replayed.d.id === missed.body.id,
  replayed.d.content,
);
const resumedFrame = await resumed.next((frame) => frame.t === "RESUMED");
check("frame RESUMED có s lớn hơn tin vừa replay", resumedFrame.s > replayed.s, `${replayed.s} → ${resumedFrame.s}`);
resumed.socket.close();
b.socket.close();

console.log(failures === 0 ? "\nTất cả bước đa node đều xanh." : `\n${failures} bước đỏ.`);
process.exit(failures === 0 ? 0 : 1);
