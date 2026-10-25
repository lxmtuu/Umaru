import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export type Pool = pg.Pool;

export interface Row {
  [key: string]: unknown;
}

export function createPool(connectionString: string, options: { max?: number } = {}): Pool {
  return new pg.Pool({ connectionString, max: options.max ?? 10 });
}

/**
 * Chạy mọi file .sql trong thư mục migration theo thứ tự tên, ghi nhận vào
 * `schema_migrations`. Mỗi file tự quản transaction (0001_init.sql có BEGIN/COMMIT).
 * Advisory lock để hai process không chạy cùng lúc.
 */
export async function migrate(pool: Pool, migrationsDir: string): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('umaru_migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set<string>(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (row) => row.name,
      ),
    );
    const files = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('umaru_migrations'))");
    } catch {
      // kết nối đã hỏng — bỏ qua, lock tự nhả khi session đóng
    }
    client.release();
  }
  return applied;
}

/** Xoá dữ liệu người dùng giữa các test (giữ schema). Chỉ dùng ở test. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE users, guilds, channels, messages, invites, read_states, relationships
     RESTART IDENTITY CASCADE`,
  );
}
