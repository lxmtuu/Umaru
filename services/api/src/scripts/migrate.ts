import { loadConfig } from "../config.js";
import { createPool, migrate } from "../db.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, { max: 1 });
try {
  const applied = await migrate(pool, config.migrationsDir);
  console.log(
    applied.length === 0
      ? "Không có migration mới."
      : `Đã áp ${applied.length} migration: ${applied.join(", ")}`,
  );
} finally {
  await pool.end();
}
