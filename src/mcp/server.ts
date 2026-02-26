import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import { PermissionManager } from './permission-manager.js';
import type { SettingsStore } from '../settings/settings-store.js';

export class MCPPermissionServer {
  private app: express.Application;
  private port: number;
  private server?: any;
  private connections: Set<any> = new Set();
  private permissionManager: PermissionManager;

  constructor(port: number = 3001, settings?: SettingsStore) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.permissionManager = new PermissionManager(settings);

    this.setupRoutes();
  }

  /**
   * Set the Discord bot instance for the permission manager
   */
  setDiscordBot(discordBot: any): void {
    this.permissionManager.setDiscordBot(discordBot);
  }

  /**
   * Get the permission manager instance
   */
  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  /**
   * Extract Discord context from HTTP headers
   */
  private extractDiscordContext(req: any): any {
    const channelId = req.headers['x-discord-channel-id'];
    const channelName = req.headers['x-discord-channel-name'];
    const userId = req.headers['x-discord-user-id'];
    const messageId = req.headers['x-discord-message-id'];
    
    if (channelId) {
      return {
        channelId: channelId,
        channelName: channelName || 'unknown',
        userId: userId || 'unknown',
        messageId: messageId,
      };
    }
    
    return undefined;
  }

  private setupRoutes(): void {
    // Handle MCP requests (stateless mode)
    this.app.post('/mcp', async (req, res) => {
      try {
        console.log('MCP request received:', req.body);
        console.log('MCP request headers:', {
          'x-discord-channel-id': req.headers['x-discord-channel-id'],
          'x-discord-channel-name': req.headers['x-discord-channel-name'],
          'x-discord-user-id': req.headers['x-discord-user-id'],
          'x-discord-message-id': req.headers['x-discord-message-id'],
        });
        
        // Extract Discord context from headers
        const discordContextFromHeaders = this.extractDiscordContext(req);
        
        // Create new MCP server instance for each request (stateless)
        const mcpServer = new McpServer({
          name: 'Claude Code Permission Server',
          version: '1.0.0',
        });

        // Add the approval tool
        mcpServer.tool(
          'approve_tool',
          {
            tool_name: z.string().describe('The tool requesting permission'),
            input: z.object({}).passthrough().describe('The input for the tool'),
            discord_context: z.object({
              channelId: z.string(),
              channelName: z.string(),
              userId: z.string(),
              messageId: z.string().optional(),
            }).optional().describe('Discord context for permission decision'),
          },
          async ({ tool_name, input, discord_context }) => {
            console.log('MCP Server: Permission request received:', { tool_name, input, discord_context });
            
            // Use discord_context from parameters, or fall back to headers
            let effectiveDiscordContext = discord_context || discordContextFromHeaders;
            
            console.log('MCP Server: Effective Discord context:', effectiveDiscordContext);
            
            try {
              const decision = await this.permissionManager.requestApproval(tool_name, input, effectiveDiscordContext);
              
              console.log('MCP Server: Permission decision:', decision);
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(decision),
                  },
                ],
              };
            } catch (error) {
              console.error('MCP Server: Error processing permission request:', error);
              
              // Return deny on error for security
              const errorDecision = {
                behavior: 'deny',
                message: `Permission request failed: ${error instanceof Error ? error.message : String(error)}`,
              };
              
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(errorDecision),
                  },
                ],
              };
            }
          }
        );

        // Create transport for this request
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // Stateless
        });

        // Clean up when request closes
        res.on('close', () => {
          console.log('MCP request closed');
          transport.close();
          mcpServer.close();
        });

        // Connect server to transport
        await mcpServer.connect(transport);
        
        // Handle the request
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    });

    // Handle GET requests (method not allowed for stateless mode)
    this.app.get('/mcp', (req, res) => {
      console.log('Received GET MCP request');
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed - this server operates in stateless mode',
        },
        id: null,
      });
    });

    // Handle DELETE requests (method not allowed for stateless mode)
    this.app.delete('/mcp', (req, res) => {
      console.log('Received DELETE MCP request');
      res.status(405).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed - this server operates in stateless mode',
        },
        id: null,
      });
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        server: 'Claude Code Permission Server',
        version: '1.0.0',
        port: this.port 
      });
    });
  }

  /**
   * Kill any process currently using our port (stale from a previous crash/kill)
   */
  private async forceReleasePort(): Promise<void> {
    try {
      // On Windows, find the PID using the port and kill it
      const result = execSync(
        `netstat -ano | findstr :${this.port} | findstr LISTENING`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (result) {
        // Extract PIDs from netstat output (last column)
        const pids = new Set<string>();
        for (const line of result.split('\n')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0') {
            pids.add(pid);
          }
        }

        for (const pid of pids) {
          // Don't kill ourselves
          if (pid === String(process.pid)) continue;
          try {
            execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf-8', timeout: 5000 });
            console.log(`Killed stale process ${pid} that was holding port ${this.port}`);
          } catch {
            // Process may already be gone
            console.log(`Could not kill PID ${pid} (may already be gone)`);
          }
        }

        // Brief pause to let the OS release the port
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch {
      // No process found on port — that's fine
    }
  }

  async start(): Promise<void> {
    // Force-release the port if a stale process is holding it
    await this.forceReleasePort();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, (err?: Error) => {
        if (err) {
          reject(err);
        } else {
          console.log(`MCP Permission Server listening on port ${this.port}`);
          console.log(`Health check: http://localhost:${this.port}/health`);
          console.log(`MCP endpoint: http://localhost:${this.port}/mcp`);
          resolve();
        }
      });

      // Track open connections so we can force-close them on shutdown
      this.connections = new Set();
      this.server.on('connection', (conn: any) => {
        this.connections.add(conn);
        conn.on('close', () => this.connections.delete(conn));
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${this.port} is still in use after cleanup attempt. Will retry once...`);
          // One more attempt after a longer delay
          setTimeout(async () => {
            await this.forceReleasePort();
            this.server = this.app.listen(this.port, (retryErr?: Error) => {
              if (retryErr) {
                reject(retryErr);
              } else {
                console.log(`MCP Permission Server listening on port ${this.port} (after retry)`);
                resolve();
              }
            });
          }, 2000);
        }
      });
    });
  }

  async stop(): Promise<void> {
    // Clean up permission manager first
    this.permissionManager.cleanup();

    if (this.server) {
      // Destroy all open connections so the server can close immediately
      for (const conn of this.connections) {
        conn.destroy();
      }
      this.connections.clear();

      return new Promise((resolve) => {
        this.server.close(() => {
          console.log('MCP Permission Server stopped');
          this.server = undefined;
          resolve();
        });

        // Safety timeout — if close hangs for more than 3s, resolve anyway
        setTimeout(() => {
          console.log('MCP server close timed out, forcing...');
          this.server = undefined;
          resolve();
        }, 3000);
      });
    }
  }

  /**
   * Synchronous cleanup for use in process 'exit' handler.
   * Cannot do async work here, but we can destroy connections
   * and close the server to free the port.
   */
  stopSync(): void {
    for (const conn of this.connections) {
      try { conn.destroy(); } catch {}
    }
    this.connections.clear();

    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = undefined;
    }
  }
}