import { z } from "zod";

// Local-only, single-user build: nothing here is required to boot the app.
// Server-side only. Client code must read `process.env.NEXT_PUBLIC_*`
// directly so Next can inline it (NEXT_PUBLIC_SITE_URL: see site/brand.ts).
// The Claude bridge address is not configurable here: it comes from
// BRIDGE_HOST/BRIDGE_PORT in @opencut/claude-tools.

// Treat `KEY=` lines in .env files as unset.
const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const webEnvSchema = z.object({
	// Node
	NODE_ENV: z.preprocess(
		emptyToUndefined,
		z.enum(["development", "production", "test"]).default("development"),
	),

	// Server (optional)
	FREESOUND_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
