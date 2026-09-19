import { bootstrap } from './config/bootstrap.js';

/**
 * Entry point, and deliberately nothing else.
 *
 * `bootstrap` loads `.env`, runs the setup wizard when it has to, and pushes
 * the answers into `process.env`. Only then is the app imported — and that
 * import has to be dynamic. Several modules read `process.env` at import time
 * (`claude/manager.ts` freezes all its timeouts as top-level consts), so a
 * static import here would evaluate them before the wizard had written a thing,
 * and every answer would take effect one restart late.
 */
async function start() {
  const outcome = await bootstrap({ argv: process.argv.slice(2) });

  if (!outcome.shouldStart) {
    process.exit(outcome.exitCode);
  }

  const { main } = await import('./app.js');
  await main();
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
