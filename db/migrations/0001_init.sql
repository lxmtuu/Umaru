-- Umaru — schema khởi tạo (G0 → G1)
-- Engine: PostgreSQL 16+ (mục tiêu: Neon free tier — ROADMAP §4.4)
--
-- Quy ước:
--   * ID = snowflake BIGINT (node-postgres trả int8 dạng string → khớp type
--     `Snowflake` (string) của @umaru/protocol, không cần convert).
--   * Permission bitfield lưu TEXT thập phân ('0'/'259'...) — parse bằng
--     parsePermissions() trong @umaru/protocol (JSON không có bigint).
--   * Thời gian TIMESTAMPTZ; API serialize ISO-8601 UTC.
--   * Xóa user → CASCADE toàn bộ (hỗ trợ yêu cầu xóa dữ liệu GDPR/Luật VN).
--
-- Xem cả: docs/data-model.md (quyết định thiết kế & thuật toán permission).

BEGIN;

-- =====================================================================
-- USERS & AUTH
-- =====================================================================

CREATE TABLE users (
  id                BIGINT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE
                    CHECK (username ~ '^[a-z0-9._-]{2,32}$'),
  display_name      TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 32),
  email             TEXT NOT NULL UNIQUE
                    CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  password_hash     TEXT NOT NULL,               -- argon2id, không bao giờ log ra
  avatar_url        TEXT,
  email_verified_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- presence (online/idle/dnd/offline) KHÔNG lưu ở DB — ephemeral trong Redis (ROADMAP §4.2);

CREATE TABLE user_sessions (                     -- refresh token cho JWT (rotation)
  id           BIGINT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL,                    -- sha256 của refresh token — không lưu plaintext
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

-- =====================================================================
-- GUILDS (server)
-- =====================================================================

CREATE TABLE guilds (
  id         BIGINT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  icon_url   TEXT,
  owner_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guild_members (
  guild_id  BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname  TEXT CHECK (nickname IS NULL OR char_length(nickname) BETWEEN 1 AND 32),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX idx_guild_members_user ON guild_members(user_id);

CREATE TABLE roles (
  id          BIGINT PRIMARY KEY,
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  color       INTEGER NOT NULL DEFAULT 0 CHECK (color BETWEEN 0 AND 16777215), -- 0xRRGGBB
  position    INTEGER NOT NULL DEFAULT 0,          -- cao = mạnh; tie-break bằng id khi sort
  permissions TEXT NOT NULL DEFAULT '0' CHECK (permissions ~ '^[0-9]+$'),
  is_everyone BOOLEAN NOT NULL DEFAULT false,      -- đúng 1 role/guild — enforce ở app
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_roles_guild_position ON roles(guild_id, position DESC, id DESC);

CREATE TABLE member_roles (
  guild_id BIGINT NOT NULL,
  user_id  BIGINT NOT NULL,
  role_id  BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id)
    REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
);

-- =====================================================================
-- CHANNELS
-- =====================================================================

CREATE TABLE channels (
  id         BIGINT PRIMARY KEY,
  guild_id   BIGINT REFERENCES guilds(id) ON DELETE CASCADE,  -- NULL = DM / group DM
  type       TEXT NOT NULL
             CHECK (type IN ('guild_text', 'guild_voice', 'category', 'dm', 'group_dm')),
  name       TEXT,                                            -- NOT NULL với guild channel (xem CHECK)
  topic      TEXT,
  parent_id  BIGINT REFERENCES channels(id) ON DELETE CASCADE, -- category cha
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (type IN ('guild_text', 'guild_voice', 'category')
      AND guild_id IS NOT NULL AND name IS NOT NULL AND char_length(name) BETWEEN 1 AND 100)
    OR
    (type IN ('dm', 'group_dm') AND guild_id IS NULL)
  ),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX idx_channels_guild_parent ON channels(guild_id, parent_id, position);

-- Thành viên DM / group DM (chỉ dùng khi guild_id IS NULL)
CREATE TABLE channel_members (
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_channel_members_user ON channel_members(user_id);
-- DM 1-1: app TÌM channel 'dm' mà 2 user cùng thuộc trước khi tạo (không tạo trùng);

CREATE TABLE permission_overwrites (
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('role', 'member')),
  target_id  BIGINT NOT NULL,                  -- role_id hoặc user_id (snowflake toàn cục không đụng nhau)
  allow      TEXT NOT NULL DEFAULT '0' CHECK (allow ~ '^[0-9]+$'),
  deny       TEXT NOT NULL DEFAULT '0' CHECK (deny ~ '^[0-9]+$'),
  PRIMARY KEY (channel_id, target_id)
);
-- app đảm bảo allow & deny = 0 (không giao nhau);

-- =====================================================================
-- MESSAGES
-- =====================================================================

CREATE TABLE messages (
  id           BIGINT PRIMARY KEY,             -- snowflake: thứ tự = id
  channel_id   BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content      TEXT NOT NULL DEFAULT '' CHECK (char_length(content) <= 4000),
               -- trần 4000 = giới hạn Nitro; app giới hạn 2000 cho free (ROADMAP §1.4)
  reply_to_id  BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  pinned       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at    TIMESTAMPTZ
);
-- Cursor pagination: WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT 50
CREATE INDEX idx_messages_channel_id ON messages(channel_id, id DESC);

CREATE TABLE attachments (
  id         BIGINT PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  url        TEXT NOT NULL,
  size       BIGINT NOT NULL CHECK (size >= 0),   -- bytes; app quota 10MB/file, ~500MB/user (§4.4)
  mime_type  TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_attachments_message ON attachments(message_id);

-- Trạng thái đã đọc (badge "chưa đọc" — P0)
CREATE TABLE read_states (
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id           BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- =====================================================================
-- SOCIAL (friends / block)
-- =====================================================================

CREATE TABLE relationships (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('friend', 'pending_out', 'pending_in', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_id),
  CHECK (user_id <> target_id)
);
CREATE INDEX idx_relationships_target ON relationships(target_id, type);
-- Quy ước quan hệ CÓ HƯỚNG: 'friend' lưu 2 dòng (A→B & B→A);
-- lời mời: pending_out ở người gửi, pending_in ở người nhận; blocked chỉ 1 chiều.

-- =====================================================================
-- INVITES
-- =====================================================================

CREATE TABLE invites (
  code       TEXT PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9]{6,16}$'),
  guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  inviter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_uses   INTEGER CHECK (max_uses IS NULL OR max_uses > 0),  -- NULL = không giới hạn
  uses       INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- tăng uses: UPDATE invites SET uses = uses + 1 WHERE code = ? AND (max_uses IS NULL OR uses < max_uses) RETURNING *

COMMIT;
