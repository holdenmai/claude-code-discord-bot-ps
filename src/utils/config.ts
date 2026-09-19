import type { Config } from '../types/index.js';

/**
 * Last line of defence, not the first.
 *
 * `config/bootstrap.ts` normally fills these in — offering the setup wizard
 * when they're missing — before this ever runs. Reaching a failure here means
 * something bypassed the bootstrap (a direct `app.ts` import, a stripped env),
 * so the message points back at the wizard rather than at hand-editing `.env`.
 */
function missing(key: string): never {
  console.error(`${key} environment variable is required`);
  console.error("Run the setup wizard to fill it in:  bun run config");
  process.exit(1);
}

export function validateConfig(): Config {
  const discordToken = process.env.DISCORD_TOKEN;
  const allowedUserId = process.env.ALLOWED_USER_ID;
  const baseFolder = process.env.BASE_FOLDER;

  if (!discordToken) {
    missing("DISCORD_TOKEN");
  }

  if (!allowedUserId) {
    missing("ALLOWED_USER_ID");
  }

  if (!baseFolder) {
    missing("BASE_FOLDER");
  }

  return {
    discordToken,
    allowedUserId,
    baseFolder,
  };
}