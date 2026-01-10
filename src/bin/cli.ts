#!/usr/bin/env node
/**
 * CLI for Agent Orchestration
 * 
 * Commands:
 *   init         - Creates AGENTS.md for cross-IDE/CLI compatibility
 *   init-cursor  - Copies .cursor/rules/ for Cursor IDE
 *   serve        - Run the MCP server (used by IDEs via npx)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the package root (dist/bin/cli.js -> ../../)
const packageRoot = path.resolve(__dirname, '..', '..');

function printUsage(): void {
  console.log(`
Agent Orchestration CLI

Usage:
  npx agent-orchestration init           Create AGENTS.md (works with any AI agent)
  npx agent-orchestration init-cursor    Setup for Cursor IDE (.cursor/rules/)
  npx agent-orchestration serve          Run the MCP server
  npx agent-orchestration help           Show this help message

Commands:
  init          Creates AGENTS.md with full orchestration instructions.
                Compatible with: OpenAI Codex, Google Jules, Cursor, Aider,
                Windsurf, VS Code Copilot, and many more.

  init-cursor   Sets up Cursor-specific rules in .cursor/rules/.
                Also creates activeContext.md and updates .gitignore.

  serve         Runs the MCP server. IDEs call this via their MCP config.
                The server uses the current working directory as the project root.

Example:
  cd /path/to/my-project
  npx agent-orchestration init
`);
}

/**
 * Load AGENTS.md template content from the package.
 */
function loadAgentsMdTemplate(): string {
  const templatePath = path.join(packageRoot, 'templates', 'AGENTS.md');

  try {
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Missing template: ${templatePath}`);
    }
    return fs.readFileSync(templatePath, 'utf-8');
  } catch (error) {
    // Fallback to a minimal stub so init still works even if the template isn't shipped.
    console.warn('[init] Failed to load templates/AGENTS.md. Writing a minimal AGENTS.md instead.', error);
    return `# AGENTS.md

This project uses **Agent Orchestration** for multi-agent coordination.

## First Action

Run the MCP tool:

\`\`\`
bootstrap
\`\`\`

Note: \`bootstrap\` is an MCP tool invocation in your agent/IDE, not a terminal command.
`;
  }
}

/**
 * Run the MCP server
 */
async function runServer(): Promise<void> {
  // Import and start the server
  const { startServer } = await import('../index.js');
  await startServer();
}

/**
 * Initialize with AGENTS.md (cross-IDE compatible)
 */
function initAgentsMd(): void {
  const cwd = process.cwd();
  console.log(`\nInitializing Agent Orchestration (AGENTS.md) in: ${cwd}\n`);

  // 1. Create AGENTS.md
  const agentsMdPath = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(agentsMdPath)) {
    fs.writeFileSync(agentsMdPath, loadAgentsMdTemplate());
    console.log('✓ Created AGENTS.md');
  } else {
    console.log('✓ AGENTS.md already exists (not overwritten)');
  }

  // 2. Update .gitignore
  updateGitignore(cwd);

  // 3. Create activeContext.md
  createActiveContext(cwd);

  // 4. Print success message
  console.log(`
✓ Setup complete!

AGENTS.md is now ready. This works with:
  - OpenAI Codex
  - Google Jules  
  - Cursor
  - Aider
  - Windsurf
  - VS Code Copilot
  - And many more!

MCP Server Config (add to your IDE):

{
  "mcpServers": {
    "agent-orchestration": {
      "command": "npx",
      "args": ["-y", "agent-orchestration", "serve"],
      "env": {
        "MCP_ORCH_SYNC_CONTEXT": "true"
      }
    }
  }
}

Then restart your IDE to activate the MCP server.
`);
}

/**
 * Initialize for Cursor IDE (copies .cursor/rules/)
 */
function initCursor(): void {
  const cwd = process.cwd();
  console.log(`\nInitializing Agent Orchestration for Cursor in: ${cwd}\n`);

  // 1. Copy Cursor rules
  const rulesSourceDir = path.join(packageRoot, '.cursor', 'rules');
  const rulesTargetDir = path.join(cwd, '.cursor', 'rules');

  if (fs.existsSync(rulesSourceDir)) {
    fs.mkdirSync(rulesTargetDir, { recursive: true });

    const ruleFiles = fs.readdirSync(rulesSourceDir);
    for (const file of ruleFiles) {
      if (file.endsWith('.mdc')) {
        const source = path.join(rulesSourceDir, file);
        const target = path.join(rulesTargetDir, file);
        fs.copyFileSync(source, target);
        console.log(`✓ Copied rule: .cursor/rules/${file}`);
      }
    }
  } else {
    console.log('⚠ Cursor rules not found in package. Skipping rule copy.');
  }

  // 2. Update .gitignore
  updateGitignore(cwd);

  // 3. Create activeContext.md
  createActiveContext(cwd);

  // 4. Print MCP config
  console.log(`
✓ Cursor setup complete!

Add this to your ~/.cursor/mcp.json:

{
  "mcpServers": {
    "agent-orchestration": {
      "command": "npx",
      "args": ["-y", "agent-orchestration", "serve"],
      "env": {
        "MCP_ORCH_SYNC_CONTEXT": "true"
      }
    }
  }
}

Then restart Cursor to activate the MCP server.
`);
}

/**
 * Update .gitignore with orchestration entries
 */
function updateGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, '.gitignore');
  const ignoreEntry = '.agent-orchestration/';

  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
  }

  if (!gitignoreContent.includes(ignoreEntry)) {
    const newContent =
      gitignoreContent.trim() + '\n\n# Agent Orchestration\n' + ignoreEntry + '\n';
    fs.writeFileSync(gitignorePath, newContent);
    console.log('✓ Added .agent-orchestration/ to .gitignore');
  } else {
    console.log('✓ .gitignore already contains .agent-orchestration/');
  }
}

/**
 * Create activeContext.md template
 */
function createActiveContext(cwd: string): void {
  const activeContextPath = path.join(cwd, 'activeContext.md');
  if (!fs.existsSync(activeContextPath)) {
    const template = `# Active Context

_Last updated: Initial setup_

## Current Focus

_Not set. Use \`memory_set\` with key "current_focus" in namespace "context"._

## Active Agents

_No active agents. Start the MCP server and register agents to see them here._

## In Progress

_No tasks in progress._

## Pending Tasks

_No pending tasks. Create tasks using the \`task_create\` tool._

## Recent Decisions

_No decisions recorded. Use \`memory_set\` in namespace "decisions" to record decisions._

## Context Notes

_No additional context._

---

_This file is auto-generated by the Agent Orchestration server._
_Edit shared memory to update this context._
`;
    fs.writeFileSync(activeContextPath, template);
    console.log('✓ Created activeContext.md');
  } else {
    console.log('✓ activeContext.md already exists');
  }
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'init':
    initAgentsMd();
    break;
  case 'init-cursor':
    initCursor();
    break;
  case 'serve':
    runServer().catch((err) => {
      console.error('Server error:', err);
      process.exit(1);
    });
    break;
  case 'help':
  case '--help':
  case '-h':
    printUsage();
    break;
  default:
    if (command) {
      console.error(`Unknown command: ${command}`);
    }
    printUsage();
    process.exit(command ? 1 : 0);
}
