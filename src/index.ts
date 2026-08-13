import { DiscordBot } from './bot/client.js';
import { ClaudeManager } from './claude/manager.js';
import { validateConfig } from './utils/config.js';
import { MCPPermissionServer } from './mcp/server.js';
import { SettingsStore } from './settings/settings-store.js';
import { InstanceRouter } from './routing/instance-router.js';

// Global backstop: a stray rejected promise (most often a Discord interaction
// ack that landed after the 3s window) must never take the whole bot down.
// Log it and keep running; per-call sites still handle their own errors.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (kept alive):', reason);
});

// Synchronous twin of the above. The flaky Claude API lives in the spawned CLI,
// so the bot only ever sees its output — but a stray synchronous throw in a sync
// callback (a stream `data` handler, a timer) would otherwise take the process
// down. Log and keep running: a dropped message beats a dead bot.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception (kept alive):', error);
});

async function main() {
  const config = validateConfig();

  // Create settings store (shared across subsystems)
  const settings = new SettingsStore();

  // Start MCP Permission Server
  const mcpPort = parseInt(process.env.MCP_SERVER_PORT || '3001');
  const mcpServer = new MCPPermissionServer(mcpPort, settings);

  console.log('Starting MCP Permission Server...');
  await mcpServer.start();

  // Set up multi-instance routing if configured
  let instanceRouter: InstanceRouter | undefined;
  const botInstanceId = process.env.BOT_INSTANCE_ID;
  if (botInstanceId) {
    const priority = parseInt(process.env.BOT_PRIORITY || '1');
    instanceRouter = new InstanceRouter(botInstanceId, priority, settings);
    console.log(`Multi-instance mode: ${botInstanceId} (priority ${priority})`);
  }

  // Start Discord Bot and Claude Manager
  const claudeManager = new ClaudeManager(config.baseFolder, settings);
  const bot = new DiscordBot(claudeManager, config.allowedUserId, settings, instanceRouter);

  // Connect MCP server to Discord bot for interactive approvals
  mcpServer.setDiscordBot(bot);
  // …and to the Claude manager, so answered questions arm the post-answer
  // watchdog that recovers a turn wedged on its own AskUserQuestion.
  mcpServer.setClaudeManager(claudeManager);
  // The reverse direction, deliberately narrowed to one question: a turn sitting
  // on an unanswered question or approval produces no output, and without this
  // the mid-turn hang reaper can't tell it apart from a wedged process.
  claudeManager.setPendingUserPromptProbe(
    (channelId) => mcpServer.getPermissionManager()?.getWaitingKind(channelId) !== undefined,
  );

  // Handle graceful shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('Shutting down gracefully...');

    // Stop MCP server first
    try {
      await mcpServer.stop();
    } catch (error) {
      console.error('Error stopping MCP server:', error);
    }

    // Stop Claude manager
    try {
      claudeManager.destroy();
    } catch (error) {
      console.error('Error stopping Claude manager:', error);
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // On Windows, process.exit() doesn't trigger SIGINT/SIGTERM.
  // This ensures the MCP server is cleaned up even on abrupt exits
  // (e.g. from /update command calling process.exit(0) directly).
  process.on('exit', () => {
    // Synchronous cleanup — destroy all connections so the port is freed
    try {
      mcpServer.stopSync();
    } catch {
      // Best effort
    }
    // Claude CLI processes outlive the turns that spawned them, so an abrupt exit
    // can leave several running with nothing to talk to. Only synchronous work is
    // possible here, so this is the tree kill rather than the graceful retire —
    // it still has to reach the grandchildren, or they outlive us holding pipes
    // and a socket to the port we just freed.
    try {
      claudeManager.killAllProcesses();
    } catch {
      // Best effort
    }
  });

  console.log('Starting Discord Bot...');
  await bot.login(config.discordToken);

  // Expose MCP server to Discord bot for reaction handling
  bot.setMCPServer(mcpServer);

  console.log('All services started successfully!');
  console.log('MCP Server and Discord Bot are now connected for interactive approvals!');
}

main().catch(console.error);
