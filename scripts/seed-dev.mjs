#!/usr/bin/env node
// Seed dữ liệu demo để QA trong trình duyệt: 3 người, 1 server có kênh chữ +
// kênh thoại, DM 1-1, group DM, bạn bè, và vài tin nhắn (markdown, mention, reply).
//
// Chạy sau `scripts/dev-pg.sh up` + migration:
//   node scripts/seed-dev.mjs
//
// Idempotent: xoá đúng 3 user demo (CASCADE kéo theo guild/kênh/tin của họ)
// rồi tạo lại. Không đụng dữ liệu khác trong database.
//
// Tài khoản:
//   demo@example.com  / mat-khau-123   (demo_user, chủ server, có quyền quản trị)
//   minh@example.com  / mat-khau-123
//   linh@example.com  / mat-khau-123
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// pnpm không hoist `pg`/`@node-rs/argon2` lên node_modules gốc → resolve theo
// package của API, nơi chúng là dependency thật.
const require = createRequire(path.join(root, "services/api/package.json"));
const { Client } = require("pg");
const argon2 = require("@node-rs/argon2");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://umaru:umaru@127.0.0.1:55432/umaru";

// Bit quyền (khớp packages/protocol/src/permissions.ts):
// VIEW_CHANNEL 1 | SEND_MESSAGES 2 | READ_HISTORY 256 | CONNECT 512 | SPEAK 1024
const EVERYONE_PERMISSIONS = "1795";
// ADMINISTRATOR = 1 << 11 — bỏ qua mọi kiểm tra quyền khác.
const ADMIN_PERMISSIONS = "2048";

const ID = {
  demo: "240329223191000001",
  minh: "240329223191000002",
  linh: "240329223191000003",
  guild: "240329223191920640",
  roleEveryone: "240329223191920641",
  roleAdmin: "240329223191920642",
  category: "240329223191920650",
  text: "240329223200309248",
  voice: "240329223250640896",
  dm: "240329223300000001",
  groupDm: "240329223300000002",
};

const PASSWORD = "mat-khau-123";
const EMAILS = ["demo@example.com", "minh@example.com", "linh@example.com"];

const client = new Client({ connectionString: DATABASE_URL });

function minutesAgo(n) {
  return new Date(Date.now() - n * 60_000);
}

async function main() {
  await client.connect();
  const hash = await argon2.hash(PASSWORD, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  await client.query("BEGIN");
  // Dọn lần chạy trước (CASCADE lo phần còn lại).
  await client.query("DELETE FROM users WHERE email = ANY($1::text[])", [EMAILS]);

  const users = [
    [ID.demo, "demo_user", "Demo", "demo@example.com"],
    [ID.minh, "minh", "Minh", "minh@example.com"],
    [ID.linh, "linh", "Linh", "linh@example.com"],
  ];
  for (const [id, username, displayName, email] of users) {
    await client.query(
      `INSERT INTO users (id, username, display_name, email, password_hash, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, username, displayName, email, hash],
    );
  }

  await client.query(
    `INSERT INTO guilds (id, name, owner_id, created_at) VALUES ($1, $2, $3, $4)`,
    [ID.guild, "Umaru Demo", ID.demo, minutesAgo(600)],
  );
  const roles = [
    [ID.roleEveryone, "everyone", 0, EVERYONE_PERMISSIONS, true],
    [ID.roleAdmin, "Quản trị", 1, ADMIN_PERMISSIONS, false],
  ];
  for (const [id, name, position, permissions, isEveryone] of roles) {
    await client.query(
      `INSERT INTO roles (id, guild_id, name, color, position, permissions, is_everyone)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ID.guild, name, isEveryone ? 0 : 0x5865f2, position, permissions, isEveryone],
    );
  }
  for (const userId of [ID.demo, ID.minh, ID.linh]) {
    await client.query(
      `INSERT INTO guild_members (guild_id, user_id, joined_at) VALUES ($1, $2, $3)`,
      [ID.guild, userId, minutesAgo(600)],
    );
    await client.query(
      `INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)`,
      [ID.guild, userId, ID.roleEveryone],
    );
  }
  await client.query(
    `INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3)`,
    [ID.guild, ID.demo, ID.roleAdmin],
  );

  const channels = [
    { id: ID.category, type: "category", name: "Bắt đầu", parentId: null, position: 0 },
    { id: ID.text, type: "guild_text", name: "chung", parentId: ID.category, position: 0 },
    { id: ID.voice, type: "guild_voice", name: "Phòng smoke", parentId: null, position: 1 },
  ];
  for (const channel of channels) {
    await client.query(
      `INSERT INTO channels (id, guild_id, type, name, parent_id, position, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        channel.id,
        ID.guild,
        channel.type,
        channel.name,
        channel.parentId,
        channel.position,
        minutesAgo(600),
      ],
    );
  }

  // DM 1-1 + group DM (3 người).
  await client.query(
    `INSERT INTO channels (id, guild_id, type, created_at) VALUES ($1, NULL, 'dm', $2)`,
    [ID.dm, minutesAgo(300)],
  );
  await client.query(
    `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)`,
    [ID.dm, ID.demo, ID.minh],
  );
  await client.query(
    `INSERT INTO channels (id, guild_id, type, created_at) VALUES ($1, NULL, 'group_dm', $2)`,
    [ID.groupDm, minutesAgo(200)],
  );
  await client.query(
    `INSERT INTO group_dms (channel_id, owner_id, name, created_at) VALUES ($1, $2, $3, $4)`,
    [ID.groupDm, ID.demo, "Đội QA", minutesAgo(200)],
  );
  await client.query(
    `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3), ($1, $4)`,
    [ID.groupDm, ID.demo, ID.minh, ID.linh],
  );

  // Bạn bè: 'friend' lưu 2 chiều (xem docs/data-model.md).
  for (const [a, b] of [
    [ID.demo, ID.minh],
    [ID.minh, ID.linh],
  ]) {
    await client.query(
      `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 'friend'), ($2, $1, 'friend')`,
      [a, b],
    );
  }

  // Tin nhắn: đủ để thấy markdown, mention, reply, tệp đính kèm không có.
  // Snowflake vượt MAX_SAFE_INTEGER (9e15) → phải dùng BigInt, nếu không mọi id
  // bị làm tròn thành cùng một số và INSERT đụng khoá chính.
  const base = 240329230000000000n;
  const messages = [
    [ID.text, ID.demo, "Chào mừng tới **Umaru Demo** — thử gõ `markdown` nhé.", 30, null],
    [ID.text, ID.minh, "Nghe rõ rồi. Mình thử *in nghiêng* và ~~gạch~~.", 24, null],
    [ID.text, ID.demo, "Trả lời tin trên để thử reply.", 18, "240329230000000001"],
    [ID.text, ID.linh, "@demo_user vào phòng thoại thử micro không?", 12, null],
    [ID.dm, ID.minh, "Nhắn riêng: tối nay họp lúc 8h nhé.", 90, null],
    [ID.groupDm, ID.demo, "Nhóm 3 người cho QA.", 45, null],
  ];
  let seq = 1;
  for (const [channelId, authorId, content, minutes, replyTo] of messages) {
    const id = String(base + BigInt(seq));
    seq += 1;
    await client.query(
      `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, channelId, authorId, content, replyTo, minutesAgo(minutes)],
    );
  }

  await client.query("COMMIT");
  await client.end();

  console.log("✓ Seed xong. Đăng nhập bằng demo@example.com / " + PASSWORD);
  console.log(`  guild=${ID.guild} text=${ID.text} voice=${ID.voice}`);
}

main().catch(async (error) => {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end().catch(() => undefined);
  console.error("✗ Seed lỗi:", error.message);
  process.exit(1);
});
