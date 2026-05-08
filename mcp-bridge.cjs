#!/usr/bin/env node

// MCP bridge script that connects stdio to our HTTP MCP server
const http = require('http');
const { Transform } = require('stream');

// Debug: Log environment variables at startup
console.error(`MCP Bridge startup: DISCORD_CHANNEL_ID=${process.env.DISCORD_CHANNEL_ID}, DISCORD_CHANNEL_NAME=${process.env.DISCORD_CHANNEL_NAME}, DISCORD_USER_ID=${process.env.DISCORD_USER_ID}`);

const MCP_SERVER_URL = 'http://localhost:3001/mcp';

// Buffer for incomplete lines across chunks
let lineBuffer = '';

// Transform stream to handle MCP messages
const mcpTransform = new Transform({
  objectMode: false,
  transform(chunk, encoding, callback) {
    lineBuffer += chunk.toString();

    // Split by newlines and process each complete JSON message separately
    const lines = lineBuffer.split('\n');
    // Keep the last element (may be incomplete)
    lineBuffer = lines.pop() || '';

    const messages = lines.filter(line => line.trim());

    if (messages.length === 0) {
      callback();
      return;
    }

    let pending = messages.length;
    const self = this;

    for (const postData of messages) {
    
    // Add Discord context environment variables as headers
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(postData)
    };
    
    // Pass Discord environment variables as headers
    if (process.env.DISCORD_CHANNEL_ID) {
      headers['X-Discord-Channel-Id'] = process.env.DISCORD_CHANNEL_ID;
      console.error(`MCP Bridge: Adding Discord headers: channelId=${process.env.DISCORD_CHANNEL_ID}, channelName=${process.env.DISCORD_CHANNEL_NAME}, userId=${process.env.DISCORD_USER_ID}`);
    }
    if (process.env.DISCORD_CHANNEL_NAME) {
      headers['X-Discord-Channel-Name'] = process.env.DISCORD_CHANNEL_NAME;
    }
    if (process.env.DISCORD_USER_ID) {
      headers['X-Discord-User-Id'] = process.env.DISCORD_USER_ID;
    }
    if (process.env.DISCORD_MESSAGE_ID) {
      headers['X-Discord-Message-Id'] = process.env.DISCORD_MESSAGE_ID;
    }

    const options = {
      hostname: 'localhost',
      port: 3001,
      path: '/mcp',
      method: 'POST',
      headers
    };

    const req = http.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        // Handle Server-Sent Events format — may contain multiple events
        const events = responseData.split('\n\n').filter(e => e.trim());
        for (const event of events) {
          if (event.startsWith('event: message\ndata: ')) {
            const jsonData = event.replace('event: message\ndata: ', '').trim();
            self.push(jsonData + '\n');
          } else if (event.trim()) {
            self.push(event);
          }
        }
        if (--pending === 0) callback();
      });
    });

    req.on('error', (err) => {
      console.error('MCP Bridge Error:', err);
      self.push(JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `MCP server connection failed: ${err.message}`
        },
        id: null
      }) + '\n');
      if (--pending === 0) callback();
    });

    req.write(postData);
    req.end();
    } // end for loop
  }
});

// Connect stdin to our transform stream to stdout
process.stdin.pipe(mcpTransform).pipe(process.stdout);

// Handle process termination
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));