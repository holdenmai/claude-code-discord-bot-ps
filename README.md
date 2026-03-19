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
4. Create `.env` file:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   ALLOWED_USER_ID=your_discord_user_id_here
   BASE_FOLDER=/path/to/your/repos
   ```
5. Run: `bun start`

## Features

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

### 6. Configure Environment Variables

Create a `.env` file in the project root:

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

Shell commands run in the channel's project directory (or worktree for threads). For Claude CLI interactive commands like `/usage` or `/compact`, use the shell prefix:

```
-claude /usage
-claude /compact
```

The bot auto-injects `--resume` into `claude` shell commands so they target the current session.

## How It Works

- Each Discord channel maps to a folder: `#my-project` → `/path/to/repos/my-project`
- Discord threads map to git worktrees within that folder
- Sessions persist per channel/thread and automatically resume
- Shows real-time tool usage and responses
- Only responds to the configured `ALLOWED_USER_ID`

For detailed setup instructions, troubleshooting, and development information, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is licensed under the MIT License.
