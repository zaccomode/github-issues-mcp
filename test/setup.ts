import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Idempotent: only migrations not yet applied run, so this is safe per file.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
