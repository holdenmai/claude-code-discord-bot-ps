# Claude Code Discord Bot

A Discord bot that runs Claude Code sessions on different projects based on Discord channel names. Each channel maps to a folder in your file system, allowing you to interact with Claude Code for different repositories through Discord.

![image](https://github.com/user-attachments/assets/d78c6dcd-eb28-48b6-be1c-74e25935b86b)

## Quickstart

1. Install [Bun](https://bun.sh/) and [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
2. Create a Discord bot at [Discord Developer Portal](https://discord.com/developers/applications)
3. Clone and setup:
   ```bash
   git clone <repository-url>
   cd claude-code-discord
   bun install
   ```
4. Run `bun start` and answer the setup questions. The first launch asks for
   your bot token, your Discord user ID and the folder holding your repos, then
   writes them to `.env` for you. Type `-help` at any question for a full
   explanation of that setting.

That's it. To go back and change anything later, `bun run config`.

## Features

- **No config file to write**: The bot asks for what it needs on first run and writes `.env` for you — `-help` at any question explains the setting
- **Channel-based project mapping**: Each Discord channel corresponds to a folder (e.g., `#my-project` → `/path/to/repos/my-project`)
- **Persistent sessions**: Sessions are maintained per channel and automatically resume
- **Real-time streaming**: See Claude Code's tool usage and responses as they happen
- **Activity logging**: Shows up to 20 lines of activity including tool calls with parameters
- **Slash commands**: Use `/clear` to reset a session

## Setup Instructions

### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Give your application a name (e.g., "Claude Code Bot")
4. Click "Create"

### 2. Create a Bot User

1. In your application, go to the "Bot" section in the left sidebar
2. Click "Add Bot"
3. Under "Token", click "Copy" to copy your bot token (keep this secure!)
4. Under "Privileged Gateway Intents", enable:
   - Message Content Intent
5. Click "Save Changes"

### 3. Invite the Bot to Your Server

1. Go to the "OAuth2" → "URL Generator" section
2. Under "Scopes", select:
   - `bot`
   - `applications.commands`
3. Under "Bot Permissions", select:
   - Send Messages
   - Use Slash Commands
   - Read Message History
   - Embed Links
4. Copy the generated URL and open it in your browser
5. Select your Discord server and authorize the bot

### 4. Get Your Discord User ID

1. Enable Developer Mode in Discord:
   - Go to Discord Settings → Advanced → Enable "Developer Mode"
2. Right-click on your username in any channel
3. Click "Copy User ID"
4. Save this ID - you'll need it for the configuration

### 5. Clone and Setup the Bot

```bash
# Clone the repository
git clone <repository-url>
cd claude-code-discord

# Install dependencies
bun install
```

### 6. Configure the Bot

You don't need to write a `.env` by hand. Start the bot and it will ask for
anything it's missing:

```bash
bun start
```

```
DISCORD_TOKEN — Discord bot token
  [required, e.g. MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.<the-rest-of-your-token>]  -help
>
```

Each question is one line. Answer `-help` and it explains the setting in full —
what it does, what the default is, and what it's stored as. Other answers you
can give at any prompt:

| Answer | What it does |
|---|---|
| *(Enter)* | Keep the current value, or take the default |
| `-help` | Explain this setting properly |
| `-clear` | Reset it to the default |
| `-skip` | Leave the rest of this section alone |
| `-done` | Stop here, saving what you've answered |
| `-abort` | Quit without saving anything |

The first run asks only for the three settings the bot can't start without, then
offers the rest. Answers are validated as you go — a user ID that isn't digits,
a port out of range or a folder that doesn't exist are caught at the prompt
rather than at startup.

**Changing settings later:**

```bash
bun run config      # walk through every setting, then exit
bun start -config   # walk through every setting, then start the bot
```

The full pass groups settings (Models, Tool approvals, Timeouts, Discord
presentation, …), shows you what each group is currently set to, and only asks
about a group if you say yes — so it's a handful of keystrokes unless you're
actually changing something.

Everything is written to `.env` in the project root, so you can still edit it by
hand; the wizard rewrites values in place and keeps your comments. See
[`.env.example`](.env.example) for the full list with documentation. A real
environment variable always wins over the file, which is what you want for
containers and launcher scripts.

If you'd rather write the file yourself, the three required settings are:

```env
# Discord bot token from step 2
DISCORD_TOKEN=your_discord_bot_token_here

# Your Discord user ID from step 4
ALLOWED_USER_ID=your_discord_user_id_here

# Base folder containing your repositories
# Each Discord channel will map to a subfolder here
# Example: if BASE_FOLDER=/Users/you/repos and channel is #my-project
# The bot will operate in /Users/you/repos/my-project
BASE_FOLDER=/path/to/your/repos
```

#### All settings

Every setting below is offered by the wizard, and every one has a longer
explanation behind `-help`. You only ever need the first three.

**Connection** — required, asked on first run:

| Setting | What it does |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Developer Portal (step 2) |
| `ALLOWED_USER_ID` | The only Discord account the bot answers (step 4) |
| `BASE_FOLDER` | Folder holding your repos; each channel maps to a subfolder |

**Models:**

| Setting | Default | What it does |
|---|---|---|
| `DEFAULT_MODEL` | `claude-opus-5` | Model new sessions start on. A session pins its model for life, so this never moves a conversation already in flight — use `/model` for that |
| `LEGACY_SESSION_MODEL` | `claude-opus-4-8` | Model for sessions recorded before pinning existed. Never comes up on a fresh install |

**Tool approvals:**

| Setting | Default | What it does |
|---|---|---|
| `MCP_SERVER_PORT` | `3001` | Local port for the approval server. Two instances on one machine need different ports |
| `MCP_APPROVAL_TIMEOUT` | `30` | Seconds an approval waits in Discord before giving up |
| `MCP_DEFAULT_ON_TIMEOUT` | `deny` | What an unanswered approval does. `allow` lets the bot work unattended — only if you trust every folder it can reach |

**Timeouts:**

| Setting | Default | What it does |
|---|---|---|
| `SESSION_IDLE_SECONDS` | `600` | How long an idle CLI process is kept alive so the next prompt skips a `--resume` |
| `TURN_INACTIVITY_SECONDS` | `600` | Silence *within a turn* before it's treated as hung. Raise it if you run long foreground builds |
| `WATCHER_MAX_HOLD_SECONDS` | `21600` | Ceiling on holding a process open for live background tasks (6 hours) |
| `QUESTION_WATCHDOG_SECONDS` | `120` | Silence allowed after you answer a question before the turn is recovered |
| `AUTOPAUSE_TIMEOUT_SECONDS` | `180` | How long `/autopause` waits for Claude to name the session |

**Discord presentation:**

| Setting | Default | What it does |
|---|---|---|
| `ENABLE_REACTIONS` | `false` | Add progress emoji to your prompt messages (required for multi-instance) |
| `REACTION_PROCESSING` | 🤝 | Emoji while a turn is running |
| `REACTION_SUCCESS` | 👍 | Emoji when a turn finishes cleanly |
| `REACTION_PARTIAL` | 🤞 | Emoji when a turn ends early |
| `REACTION_FAILED` | 👎 | Emoji when a turn errors out |
| `PROMPT_LINK_STYLE` | `link` | "Jump to prompt" link style: `link`, `plaintext`, `embed`, `none` |
| `ACTIVITY_LINKS` | `false` | Post activity links to the home category's `#general` |
| `ACTIVITY_LINK_STYLE` | `plaintext` | How those links are posted: `plaintext`, `embed`, `link` |

Emoji are set as actual characters (🤝), not Discord's `:shortcode:` form.

**Multi-instance** — see [Multi-Instance (Teleport)](#multi-instance-teleport):

| Setting | Default | What it does |
|---|---|---|
| `BOT_INSTANCE_ID` | *(off)* | Name for this machine. Leave empty for a single-machine setup |
| `BOT_PRIORITY` | `1` | Lowest number wins; higher numbers act as fallbacks |

**Logging:**

| Setting | Default | What it does |
|---|---|---|
| `LOG_MAX_MB` | `256` | Rotate `log.txt` past this size, keeping one previous generation as `log.txt.1` |

### 7. Prepare Your Repository Structure

Organize your repositories under the base folder with names matching your Discord channels:

```
/path/to/your/repos/
├── my-project/          # Maps to #my-project channel
├── another-repo/        # Maps to #another-repo channel
├── test-app/           # Maps to #test-app channel
└── experimental/       # Maps to #experimental channel
```

**Important**: Channel names in Discord should match folder names exactly (Discord will convert spaces to hyphens).

### 8. Create Discord Channels

In your Discord server, create channels for each repository:
- `#my-project`
- `#another-repo` 
- `#test-app`
- `#experimental`

### 9. Run the Bot

```bash
# Start the bot
bun run src/index.ts

# Or use the npm script
bun start
```

Command-line options:

| Option | What it does |
|---|---|
| *(none)* | Start normally, asking about configuration only if something required is missing |
| `-config` | Walk through every setting, then start |
| `-configonly` | Walk through every setting and exit (same as `bun run config`) |
| `-help` | Print usage |

**Important**: Do not use hot reload (`bun --hot`) as it can cause issues with process management and spawn multiple Claude processes.

You should see:
```
Bot is ready! Logged in as Claude Code Bot#1234
Successfully registered application commands.
```

## Usage

Type any message in a channel that corresponds to a repository folder. The bot will run Claude Code with your message as the prompt and stream the results.

### Commands

- **Any message**: Runs Claude Code with your message as the prompt
- **`-command`**: Runs a shell command in the project directory (e.g., `-git status`, `-ls -la`)
- **`--flag`**: Passes raw CLI arguments to Claude Code (e.g., `--model sonnet`)
- **/clear**: Resets the current channel's session (starts fresh next time)
- **/kill**: Kill the running Claude Code process in this channel
- **/killall**: Kill all running Claude Code processes
- **/model**: Set the Claude model for this channel (sonnet/opus/haiku)
- **/add**: Create a channel for a project folder (with autocomplete)
- **/update**: Pull latest changes and restart the bot
- **/shortcut**: Manage custom `!command` shortcuts (add/remove/list)
- **/sync**: Merge main into all active worktrees for this project
- **/end**: End a worktree session — pushes branch to origin, removes the worktree, and locks/archives the thread
- **/adopt**: Adopt a Claude CLI session started outside the bot (e.g., from a terminal in `~/Documents`). Autocomplete shows sessions not already in `BASE_FOLDER`. Creates a channel with a persistent directory override.
- **/status**: Show a summary of recent activity across all project channels in the home category — includes last summary, turn count, and cost
- **/todo**: Per-channel todo notes. Subcommands: `add`, `list`, `done`, `clear`. Thread todos are visible from the parent channel.
- **/init**: Set this channel's category as the home for startup links

### Example

```
You: hello
Bot: 🔧 LS (path: .)
     🔧 Read (file_path: ./package.json)
     Hello! I can see this is a Node.js project. What would you like to work on?
     ✅ Completed (3 turns)
```

## Threads as Git Worktrees

Discord threads can be used to work on feature branches within a project using [git worktrees](https://git-scm.com/docs/git-worktree). The thread name maps to a worktree inside the parent channel's repo:

```
#my-project                          → /repos/my-project  (main branch)
  └─ Thread: "add-login-page"       → /repos/my-project/.worktrees/add-login-page
  └─ Thread: "fix-header-bug"       → /repos/my-project/.worktrees/fix-header-bug
```

### How it works

1. **Create a thread** in any project channel
2. **Send a message** in the thread — the bot prompts you to confirm worktree creation
3. **Confirm or override** the branch name (defaults to the thread name, branching from `main`)
4. The worktree is created and all subsequent messages in the thread run Claude Code in that worktree

If the worktree already exists (e.g., you created it locally with `git worktree add`), the bot picks it up automatically with no confirmation needed.

### Message prefixes

| Prefix | Behavior | Example |
|--------|----------|---------|
| *(none)* | Send as a prompt to Claude Code | `fix the login bug` |
| `!` | Run a custom shortcut | `!imp`, `!imp auth module` |
| `-` | Run as a shell command | `-git status` |
| `--` | Pass as raw CLI args to Claude Code | `--model sonnet` |

### Custom shortcuts

Define reusable prompt shortcuts with the `!` prefix. Shortcuts can be **global** (available in all channels) or **per-repo** (specific to a channel/project). Per-repo shortcuts take priority over global ones with the same name.

```
/shortcut add name:imp prompt:implement the plan global:true
/shortcut add name:imp prompt:implement the plan prompt_with_message:implement {message} from the plan global:true
```

- `!imp` → "implement the plan"
- `!imp the auth module` → "implement the auth module from the plan"

The optional `prompt_with_message` parameter defines an alternate template used when extra text is provided. Use `{message}` as a placeholder for the extra text. If `prompt_with_message` is not set, extra text is appended to the base prompt.

Use `/shortcut list` to see all shortcuts for the current channel, and `/shortcut remove` to delete one.

### Crash Recovery

If the bot crashes while processing, it tracks which channels had active runs. On restart, it checks for an `!oncrash` shortcut and automatically sends that prompt to each interrupted channel:

```
/shortcut add name:oncrash prompt:check git status, verify nothing is broken, and summarize what you were working on global:true
```

The `!oncrash` shortcut can be global or per-repo like any other shortcut.

Shell commands run in the channel's project directory (or worktree for threads). For Claude CLI interactive commands like `/usage` or `/compact`, use the shell prefix:

```
-claude /usage
-claude /compact
```

The bot auto-injects `--resume` into `claude` shell commands so they target the current session.

## Multi-Instance (Teleport)

Run multiple bot instances on different machines (e.g., Linux and Windows) in the same Discord server. Each instance handles channels based on priority, with automatic failover.

### Setup

1. Create **two Discord bot applications** and invite both to your server
2. On each machine, run `bun run config` and answer `y` at the **Multi-instance**
   and **Discord presentation** groups — or set the values directly in `.env`:

```env
# Machine 1 (primary)
BOT_INSTANCE_ID=linux
BOT_PRIORITY=1

# Machine 2 (fallback)
BOT_INSTANCE_ID=windows
BOT_PRIORITY=2
```

`ENABLE_REACTIONS=true` is required for multi-instance mode (the processing reaction acts as a distributed lock).

Leaving `BOT_INSTANCE_ID` empty switches multi-instance routing off entirely, which is the single-machine default.

### How routing works

- **Priority 1** processes messages immediately
- **Priority 2** waits 5 seconds, then checks if priority 1 already reacted — if not, it takes over (failover)
- Once a bot handles a message, it **owns** that channel until explicitly transferred

### Commands

| Command | Behavior |
|---------|----------|
| `!teleport @BotName` | Transfer channel to the mentioned bot |
| `!teleport` | Show which instance owns this channel |
| `!abandon` | Release channel ownership — next message uses priority routing |

### Failover

If the primary machine goes offline, the fallback instance automatically picks up new messages after a brief delay. No manual intervention needed.

## How It Works

- Each Discord channel maps to a folder: `#my-project` → `/path/to/repos/my-project`
- Discord threads map to git worktrees within that folder
- Sessions persist per channel/thread and automatically resume
- Shows real-time tool usage and responses
- Only responds to the configured `ALLOWED_USER_ID`

For detailed setup instructions, troubleshooting, and development information, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is licensed under the MIT License.
