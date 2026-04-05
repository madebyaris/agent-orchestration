#!/usr/bin/env node
/**
 * Agent Orchestration Server
 * 
 * A Model Context Protocol server that enables multiple AI agents to share
 * memory, coordinate tasks, and collaborate effectively across IDEs and CLI tools.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDatabase, closeDatabase } from './database.js';
import {
  registerAgentTools,
  registerMemoryTools,
  registerTaskTools,
  registerCoordinationTools,
  registerUtilityTools,
  registerResearchTools,
  registerProxyTools,
  registerProviderTools,
} from './tools/index.js';

// Create server instance
const server = new McpServer({
  name: 'agent-orchestration',
  version: '0.5.2',
});

// Register all tools
registerAgentTools(server);
registerMemoryTools(server);
registerTaskTools(server);
registerCoordinationTools(server);
registerUtilityTools(server);
registerResearchTools(server);
registerProviderTools(server);



/**
 * Start the MCP server
 */
export async function startServer(): Promise<void> {
  // Initialize database
  const db = getDatabase();
  console.error(`Agent Orchestration server started. Database: ${db.dbPath}`);

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Handle shutdown
  process.on('SIGINT', () => {
    console.error('Shutting down...');
    closeDatabase();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('Shutting down...');
    closeDatabase();
    process.exit(0);
  });

  // Register proxy tools
  await registerProxyTools(server);

  // Connect and run
  await server.connect(transport);
}

// Auto-run when executed directly (node dist/index.js)
// Check if this file is the main module being run
const isMainModule = process.argv[1]?.endsWith('index.js') && !process.argv[1]?.includes('cli.js');

if (isMainModule) {
  startServer().catch((error) => {
    console.error('Fatal error:', error);
    closeDatabase();
    process.exit(1);
  });
}
