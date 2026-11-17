import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside the Workers runtime, against local simulators of the
 * bindings in wrangler.jsonc: nothing reaches Cloudflare or GitHub. The D1
 * migrations are read here, in Node, and applied by test/setup.ts.
 */
export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");

	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						// Stand-ins for the Worker secrets; see README "Set the secrets".
						GITHUB_CLIENT_SECRET: "test-client-secret",
						GITHUB_APP_PRIVATE_KEY: "test-private-key",
					},
				},
			}),
		],
		test: {
			include: ["test/**/*.test.ts"],
			setupFiles: ["./test/setup.ts"],
		},
	};
});
