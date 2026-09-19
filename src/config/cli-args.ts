/**
 * The handful of flags the bot itself understands. Everything else is a
 * setting, and settings live in `.env` / the wizard rather than in argv.
 */

export interface CliArgs {
  /** Run the wizard before starting. */
  config: boolean;
  /** Run the wizard and stop; never start the bot. */
  configOnly: boolean;
  /** Print usage and stop. */
  help: boolean;
  /** Flags we didn't recognise, reported rather than silently ignored. */
  unknown: string[];
}

/** `-config`, `--config`, `--config-only` and friends all mean what they look like. */
function canonical(arg: string): string {
  return `-${arg.replace(/^-+/, '').replace(/-/g, '').toLowerCase()}`;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { config: false, configOnly: false, help: false, unknown: [] };

  for (const arg of argv) {
    if (!arg.startsWith('-')) continue;
    switch (canonical(arg)) {
      case '-configonly':
        args.configOnly = true;
        args.config = true;
        break;
      case '-config':
        args.config = true;
        break;
      case '-help':
      case '-h':
      case '-?':
        args.help = true;
        break;
      default:
        args.unknown.push(arg);
    }
  }

  return args;
}

export const USAGE = `Claude Code Discord bot

Usage: bun run start [options]

Options:
  -config       Walk through the settings, then start the bot
  -configonly   Walk through the settings and exit without starting
  -help         Show this message

With no options the bot starts normally, and only asks about configuration
when a required setting is missing. Settings are stored in .env; the wizard
rewrites that file in place, keeping any comments you have added.

Shortcut: bun run config  (same as -configonly)`;
