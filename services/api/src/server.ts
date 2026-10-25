import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

const applied = await migrate(pool, config.migrationsDir);
if (applied.length > 0) console.log(`Đã áp migration: ${applied.join(", ")}`);

const { app } = await buildApp({ config, pool });
await app.listen({ port: config.port, host: config.host });
console.log(`Umaru API: http://${config.host}:${config.port}/api/v1`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await pool.end();
      process.exit(0);
    })();
  });
}
