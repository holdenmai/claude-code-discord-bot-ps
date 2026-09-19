import { USAGE, parseCliArgs } from './cli-args.js';
import { applyEnv, envFilePath, readEnvFile, writeEnvFile } from './env-file.js';
import { SETTINGS, requiredSettings } from './settings-schema.js';
import { createTerminalIo, runWizard } from './wizard.js';
import type { WizardIo } from './wizard.js';

/**
 * Everything that has to happen before the bot's modules are imported.
 *
 * The ordering constraint is real and easy to miss: several modules read
 * `process.env` at *import* time (`claude/manager.ts` freezes every timeout as
 * a top-level const). A wizard that ran inside `main()` would write values
 * nothing reads until the next restart. So `index.ts` runs this first and only
 * then dynamically imports the app.
 */

export interface BootstrapOutcome {
  /** Whether to go on and start the bot. */
  shouldStart: boolean;
  /** Process exit code when `shouldStart` is false. */
  exitCode: number;
}

export interface BootstrapDeps {
  argv: readonly string[];
  /** Overridden in tests; otherwise a readline interface on stdin. */
  createIo?: () => Promise<WizardIo & { close?: () => void }>;
  /** Whether we can prompt at all. A piped or service-managed stdin can't. */
  isInteractive?: () => boolean;
  log?: (message: string) => void;
  envFile?: string;
}

function missingRequired(): string[] {
  return requiredSettings()
    .filter((setting) => {
      const value = process.env[setting.key];
      return value === undefined || value.trim() === '';
    })
    .map((setting) => setting.key);
}

export async function bootstrap(deps: BootstrapDeps): Promise<BootstrapOutcome> {
  const log = deps.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const isInteractive = deps.isInteractive ?? (() => Boolean(process.stdin.isTTY));
  const file = deps.envFile ?? envFilePath();

  const args = parseCliArgs(deps.argv);

  if (args.help) {
    log(USAGE);
    return { shouldStart: false, exitCode: 0 };
  }

  if (args.unknown.length > 0) {
    log(`Unknown option: ${args.unknown.join(', ')}`);
    log('');
    log(USAGE);
    return { shouldStart: false, exitCode: 1 };
  }

  // A real environment variable beats the file, so a launcher or container can
  // override one setting without the wizard or an edit.
  applyEnv(readEnvFile(file), { override: false });

  const missingBefore = missingRequired();
  const needsWizard = args.config || missingBefore.length > 0;

  if (needsWizard) {
    if (!isInteractive()) {
      // Nobody is there to answer. Say exactly what's missing and how to fix it
      // rather than blocking forever on a prompt that will never be read.
      if (missingBefore.length > 0) {
        log(`Missing required configuration: ${missingBefore.join(', ')}`);
        log(`Run the setup wizard with:  bun run config`);
        log(`…or set them in ${file}.`);
      } else {
        log('Cannot run the setup wizard: this terminal is not interactive.');
        log(`Edit ${file} directly instead.`);
      }
      return { shouldStart: false, exitCode: 1 };
    }

    const io = deps.createIo ? await deps.createIo() : await createTerminalIo();
    try {
      // Show what is actually in effect, not just what the file says: a setting
      // overridden by a real environment variable would otherwise be displayed
      // as its default, and the user would "change" it to no visible effect.
      const fileValues = readEnvFile(file);
      const current: Record<string, string | undefined> = {};
      for (const setting of SETTINGS) {
        current[setting.key] = process.env[setting.key] ?? fileValues[setting.key];
      }

      const result = await runWizard({
        mode: args.config ? 'full' : 'first-run',
        current,
        io,
      });

      if (result.aborted) {
        io.write('');
        io.write('Nothing was saved.');
        const stillMissing = missingRequired();
        if (stillMissing.length > 0) {
          io.write(`Still missing: ${stillMissing.join(', ')} — the bot cannot start.`);
          return { shouldStart: false, exitCode: 1 };
        }
        return { shouldStart: !args.configOnly, exitCode: 0 };
      }

      if (result.values.size > 0) {
        const written = writeEnvFile(result.values, file);
        applyEnv(written, { override: true });
        // A cleared setting is absent from the file rather than empty in it, so
        // it has to be removed from an env that was loaded before the wizard.
        for (const [key, value] of result.values) {
          if (value === null) delete process.env[key];
        }
        io.write('');
        io.write(`Saved ${result.values.size} setting${result.values.size === 1 ? '' : 's'} to ${file}.`);
      } else {
        io.write('');
        io.write('No changes.');
      }
    } finally {
      io.close?.();
    }

    const stillMissing = missingRequired();
    if (stillMissing.length > 0) {
      log(`Still missing required configuration: ${stillMissing.join(', ')}`);
      return { shouldStart: false, exitCode: 1 };
    }
  }

  if (args.configOnly) {
    log('Configuration complete. Start the bot with: bun run start');
    return { shouldStart: false, exitCode: 0 };
  }

  return { shouldStart: true, exitCode: 0 };
}
