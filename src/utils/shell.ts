export function escapeShellString(str: string): string {
  // PowerShell: wrap in single quotes, escape ' by doubling it
  return `'${str.replace(/'/g, "''")}'`;
}

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface DiscordContext {
  channelId: string;
  channelName: string;
  userId: string;
  messageId?: string;
}

export function isRawCommand(prompt: string): boolean {
  return prompt.startsWith("--");
}

export function buildClaudeCommand(
  workingDir: string,
  prompt: string,
  sessionId?: string,
  discordContext?: DiscordContext,
  model: string = "opus",
  imageUrls?: string[]
): string {
  const raw = isRawCommand(prompt);

  // Create session-specific MCP config in /tmp
  const sessionMcpConfigPath = createSessionMcpConfig(discordContext);

  const commandParts = [
    "claude",
    "--output-format",
    "stream-json",
    "--model",
    model,
  ];

  if (raw) {
    // Raw CLI command: pass arguments directly without -p wrapper
    commandParts.push(...prompt.split(/\s+/));
  } else {
    // Normal prompt mode
    if (imageUrls && imageUrls.length > 0) {
      for (const imageUrl of imageUrls) {
        commandParts.push("--image", imageUrl);
      }
    }

    commandParts.push("-p", escapeShellString(prompt));
  }

  commandParts.push("--verbose");

  // Always use Accept Edits permission mode
  commandParts.push("--permission-mode", "acceptEdits");

  // Add session-specific MCP configuration
  commandParts.push("--mcp-config", sessionMcpConfigPath);
  commandParts.push("--permission-prompt-tool", "mcp__discord-permissions__approve_tool");

  // Add allowed tools - we'll let the MCP server handle permissions
  commandParts.push("--allowedTools", "mcp__discord-permissions");

  if (sessionId) {
    commandParts.splice(3, 0, "--resume", sessionId);
  }

  return commandParts.join(" ");
}

/**
 * Create a session-specific MCP config file with hardcoded Discord context
 */
function createSessionMcpConfig(discordContext?: DiscordContext): string {
  // Generate unique session ID for this config
  const sessionId = `claude-discord-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const configPath = path.join(os.tmpdir(), `mcp-config-${sessionId}.json`);
  
  const baseDir = path.dirname(path.dirname(__dirname)); // Go up to project root
  const bridgeScriptPath = path.join(baseDir, 'mcp-bridge.cjs');
  
  // Create MCP config with hardcoded environment variables
  const mcpConfig = {
    mcpServers: {
      "discord-permissions": {
        command: "node",
        args: [bridgeScriptPath],
        env: {
          DISCORD_CHANNEL_ID: discordContext?.channelId || "unknown",
          DISCORD_CHANNEL_NAME: discordContext?.channelName || "unknown", 
          DISCORD_USER_ID: discordContext?.userId || "unknown",
          DISCORD_MESSAGE_ID: discordContext?.messageId || ""
        }
      }
    }
  };
  
  // Write the config file
  fs.writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  
  console.log(`Created session MCP config: ${configPath}`);
  console.log(`Discord context: ${JSON.stringify(discordContext)}`);
  
  // Clean up old session config files (older than 1 hour)
  cleanupOldSessionConfigs();
  
  return configPath;
}

/**
 * Clean up old session MCP config files from /tmp
 */
function cleanupOldSessionConfigs(): void {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    const oneHourAgo = Date.now() - (60 * 60 * 1000); // 1 hour in milliseconds
    
    for (const file of files) {
      if (file.startsWith('mcp-config-claude-discord-') && file.endsWith('.json')) {
        const filePath = path.join(tmpDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < oneHourAgo) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old MCP config: ${filePath}`);
        }
      }
    }
  } catch (error) {
    console.error('Error cleaning up old MCP configs:', error);
  }
}