import type {
  Channel,
  ChannelType,
  Guild,
  Message,
  PresenceStatus,
  Role,
  Snowflake,
  User,
} from "@umaru/protocol";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  email: string;
  password_hash: string;
  avatar_url: string | null;
  email_verified_at: Date | null;
  created_at: Date;
}

export interface GuildRow {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  created_at: Date;
}

export interface RoleRow {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  is_everyone: boolean;
}

export interface ChannelRow {
  id: string;
  guild_id: string | null;
  type: ChannelType;
  name: string | null;
  topic: string | null;
  parent_id: string | null;
  position: number;
}

export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  content: string;
  reply_to_id: string | null;
  pinned: boolean;
  created_at: Date;
  edited_at: Date | null;
}

export const snowflake = (value: string): Snowflake => value as Snowflake;

export function mapUser(row: UserRow, status: PresenceStatus = "offline"): User {
  return {
    id: snowflake(row.id),
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    status,
    emailVerified: row.email_verified_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

export function mapGuild(row: GuildRow): Guild {
  return {
    id: snowflake(row.id),
    name: row.name,
    iconUrl: row.icon_url,
    ownerId: snowflake(row.owner_id),
    createdAt: row.created_at.toISOString(),
  };
}

export function mapRole(row: RoleRow): Role {
  return {
    id: snowflake(row.id),
    guildId: snowflake(row.guild_id),
    name: row.name,
    color: row.color,
    position: row.position,
    permissions: row.permissions,
    isEveryone: row.is_everyone,
  };
}

export function mapChannel(row: ChannelRow): Channel {
  return {
    id: snowflake(row.id),
    guildId: row.guild_id === null ? null : snowflake(row.guild_id),
    type: row.type,
    name: row.name,
    topic: row.topic,
    categoryId: row.parent_id === null ? null : snowflake(row.parent_id),
    position: row.position,
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: snowflake(row.id),
    channelId: snowflake(row.channel_id),
    authorId: snowflake(row.author_id),
    content: row.content,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at === null ? null : row.edited_at.toISOString(),
    replyToId: row.reply_to_id === null ? null : snowflake(row.reply_to_id),
    // Upload file chưa có ở bước này (G1 sẽ thêm R2 presign) — luôn [] thay vì undefined.
    attachments: [],
    pinned: row.pinned,
  };
}
