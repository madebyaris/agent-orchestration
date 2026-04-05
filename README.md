# Agent Orchestration

[![npm version](https://badge.fury.io/js/agent-orchestration.svg)](https://www.npmjs.com/package/agent-orchestration)
[![GitHub](https://img.shields.io/github/license/madebyaris/agent-orchestration)](https://github.com/madebyaris/agent-orchestration/blob/main/LICENSE)

A Model Context Protocol (MCP) server that enables multiple AI agents to share memory, coordinate tasks, and collaborate effectively across IDEs and CLI tools.

## The Problem

When running multiple AI agents, they face critical coordination challenges:

1. **No Turn Awareness** - Agents don't know if it's their turn to act, leading to race conditions
2. **File-Based Prediction** - Agents predict state from files, not shared memory, causing stale reads
3. **Context Drift** - Parallel agents develop inconsistent understanding of the codebase
4. **No Agent Discovery** - Agents are unaware of other agents working on the same project
5. **Duplicate Work** - Multiple agents may attempt the same task simultaneously
6. **Conflicting Edits** - Without coordination, agents overwrite each other's changes

## Solution

This MCP server provides:

- **Shared Memory** - Agents can store and retrieve context, decisions, and findings
- **Task Queue** - Turn-based task execution with dependencies
- **Agent Discovery** - Agents can see who else is working on the project
- **Resource Locking** - Prevent concurrent access to files or resources
- **Research-First Workflow** - Ensures agents understand context before coding
- **Coordination Status** - Real-time visibility into the orchestration state
- **Auto Context Sync** - Automatically updates `activeContext.md` for easy reference

## Compatibility

Works with any AI coding agent that supports MCP or [AGENTS.md](https://agents.md/):

- **OpenAI Codex**
- **Google Jules**
- **Cursor**
- **Aider**
- **Windsurf**
- **VS Code Copilot**
- **GitHub Copilot Coding Agent**
- **Devin**
- And many more!

## Quick Start

No installation required! Just use `npx`:

### For Any IDE/CLI (AGENTS.md)

```bash
# Navigate to your project
cd /path/to/your/project

# Initialize with AGENTS.md
npx agent-orchestration init
```

This creates `AGENTS.md` with full orchestration instructions that work with any AI coding agent.

### For Cursor IDE

```bash
# Navigate to your project
cd /path/to/your/project

# Initialize for Cursor (copies .cursor/rules/)
npx agent-orchestration init-cursor
```

This copies `.cursor/rules/` with Cursor-specific rules.

## CLI Commands

```bash
npx agent-orchestration init           # Create AGENTS.md (works with any AI agent)
npx agent-orchestration init-cursor    # Setup for Cursor IDE (.cursor/rules/)
npx agent-orchestration serve          # Run the MCP server
npx agent-orchestration cursor check   # Verify Cursor CLI support
npx agent-orchestration cursor delegate --task <task-id>
npx agent-orchestration cursor resume --task <task-id>
npx agent-orchestration cursor list    # Show delegated Cursor tasks
npx agent-orchestration help           # Show help
```

## MCP Server Setup

Add to your MCP configuration (e.g., `~/.cursor/mcp.json` for Cursor):

```json
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
```

The server automatically uses the current working directory as the project root.

### Start Your Session

Use the `bootstrap` tool to start:

```
bootstrap
```

**Note**: `bootstrap` is an MCP tool invocation inside your agent/IDE, not a terminal command.

This registers you, shows current focus, pending tasks, and recent decisions.

## Available Tools

### Session Management

| Tool | Description |
|------|-------------|
| `bootstrap` | **Start here!** Initialize session: register, get focus, tasks, decisions |
| `claim_todo` | **For sub-agents**: Register + create/claim a task in one call |
| `agent_whoami` | Get your current agent info (ID, name, role, status) |

### Agent Management

| Tool | Description |
|------|-------------|
| `agent_register` | Register this agent with the orchestration system |
| `agent_heartbeat` | Send a heartbeat to indicate agent is active |
| `agent_list` | List all registered agents |
| `agent_unregister` | Unregister this agent (releases all locks) |

### Shared Memory

| Tool | Description |
|------|-------------|
| `memory_set` | Store a value in shared memory |
| `memory_get` | Retrieve a value from shared memory |
| `memory_list` | List all keys in a namespace |
| `memory_delete` | Delete a value from shared memory |

### Task Management

| Tool | Description |
|------|-------------|
| `task_create` | Create a new task (auto-detects complexity) |
| `task_claim` | Claim a task to work on (requires research for non-trivial) |
| `task_update` | Update task status or progress |
| `task_complete` | Mark a task as completed |
| `task_list` | List tasks with filters |
| `is_my_turn` | Check if work is available for you |

### Research Workflow

| Tool | Description |
|------|-------------|
| `research_ready` | Mark research complete for a task |
| `research_status` | Check research progress for a task |
| `research_query` | Search past research findings |
| `research_checklist` | View research requirements by complexity |

### Coordination

| Tool | Description |
|------|-------------|
| `lock_acquire` | Acquire a lock on a resource |
| `lock_release` | Release a held lock |
| `lock_check` | Check if a resource is locked |
| `coordination_status` | Get overall system status |

### Cursor Provider

| Tool | Description |
|------|-------------|
| `cursor_check` | Verify Cursor CLI availability and supported features |
| `cursor_delegate_task` | Launch a Cursor CLI run for a task and persist session metadata |
| `cursor_resume_task` | Return the resume command for a delegated task |
| `cursor_list_delegations` | Show delegated Cursor tasks and their last known status |

## Cursor-Native Delegation

You can now delegate orchestrator tasks directly to Cursor CLI instead of manually creating a plan, opening a new tab, and pasting context yourself.

### CLI Workflow

```bash
# Verify Cursor CLI is available
npx agent-orchestration cursor check

# Delegate a task to Cursor
npx agent-orchestration cursor delegate --task <task-id> --mode agent

# Resume the delegated session later
npx agent-orchestration cursor resume --task <task-id>

# Or launch the resume session immediately
npx agent-orchestration cursor resume --task <task-id> --exec
```

### MCP Workflow

```text
cursor_delegate_task:
  task_id: "<task-id>"
  mode: "agent"
  use_worktree: true
```

Delegations store provider metadata directly on the task, including:

- Cursor chat/session ID
- provider status
- worktree usage
- launch command
- run log path

Moderate and complex tasks default to Cursor worktrees for safer parallel execution.

## Research-First Workflow

Tasks are automatically assigned a complexity level that determines research requirements:

| Complexity | Examples | Research Required |
|------------|----------|-------------------|
| `trivial` | Typo fix, config change | None |
| `simple` | Bug fix, small refactor | context, files |
| `moderate` | New endpoint, component | + requirements |
| `complex` | New feature, migration | + design |

### How It Works

1. **Task Creation** - Complexity is auto-detected from keywords (or manually set)
2. **Research Phase** - Agent documents findings in structured namespaces
3. **Research Gate** - `task_claim` is blocked until research is complete
4. **Implementation** - Agent proceeds with full context

### Research Namespaces

```
research:<task_id>:context      # Understanding of codebase
research:<task_id>:files        # Affected files identified
research:<task_id>:requirements # Specs and edge cases
research:<task_id>:design       # Architecture decisions
```

## Recommended Workflow

### Main Orchestrator Agent

```
1. bootstrap                          # Start session
2. memory_set current_focus "..."     # Set project focus
3. task_create "Feature X"            # Create tasks (complexity auto-detected)
4. task_create "Feature Y"
5. coordination_status                # Monitor progress
```

### Sub-Agents (Spawned for Specific Work)

```
1. claim_todo "Feature X"             # Register + see research checklist

# Research Phase (for non-trivial tasks)
2. memory_set key="understanding" namespace="research:<task_id>:context" value="..."
3. memory_set key="files" namespace="research:<task_id>:files" value="..."
4. research_ready task_id="<task_id>" # Validate research complete

# Implementation Phase
5. task_claim task_id="<task_id>"     # Now allowed to start
6. lock_acquire "src/feature.ts"      # Lock files before editing
7. [do the work]
8. task_complete <task_id> "Done"     # Complete the task
9. agent_unregister                   # Clean up
```

### Trivial Tasks (No Research)

```
1. claim_todo "Fix typo in README"    # Complexity: trivial
2. task_claim task_id="<task_id>"     # Immediately allowed
3. [do the work]
4. task_complete <task_id> "Done"
```

## Memory Namespaces

Use these namespaces for organization:

| Namespace | Purpose | Example Keys |
|-----------|---------|--------------|
| `context` | Current state and focus | `current_focus`, `current_branch` |
| `decisions` | Architectural decisions | `auth_strategy`, `db_choice` |
| `findings` | Analysis results | `perf_issues`, `security_audit` |
| `blockers` | Issues blocking progress | `api_down`, `missing_deps` |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_ORCH_DB_PATH` | Path to SQLite database | `.agent-orchestration/orchestrator.db` |
| `MCP_ORCH_SYNC_CONTEXT` | Auto-sync activeContext.md | `false` |
| `MCP_ORCH_AGENT_NAME` | Default agent name | Auto-generated |
| `MCP_ORCH_AGENT_ROLE` | Default agent role | `sub` |
| `MCP_ORCH_CAPABILITIES` | Comma-separated capabilities | `code` |

### `agent-orchestration.config.json`

Optional project-level config for Cursor orchestration:

```json
{
  "cursor": {
    "binary": "agent",
    "defaultMode": "agent",
    "defaultForce": true,
    "autoApproveMcps": true,
    "trustWorkspace": true,
    "useCreateChat": true,
    "logDir": ".agent-orchestration/providers/cursor",
    "preferWorktreeFor": ["moderate", "complex"]
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     IDE / CLI Tool                           │
├─────────────┬─────────────┬─────────────┬─────────────┬─────┤
│ Main Agent  │ Sub-Agent 1 │ Sub-Agent 2 │ Sub-Agent 3 │ ... │
└──────┬──────┴──────┬──────┴──────┬──────┴──────┬──────┴─────┘
       │             │             │             │
       └─────────────┴──────┬──────┴─────────────┘
                            │
                    ┌───────▼───────┐
                    │  MCP Server   │
                    │  (TypeScript) │
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
      ┌───────▼───┐ ┌───────▼───┐ ┌───────▼───┐
      │  Agents   │ │   Tasks   │ │  Memory   │
      │  Registry │ │   Queue   │ │   Store   │
      └───────────┘ └───────────┘ └───────────┘
              │             │             │
              └─────────────┼─────────────┘
                            │
                    ┌───────▼───────┐
                    │    SQLite     │
                    │  (per-project)│
                    └───────────────┘
```

## AGENTS.md

This project follows the [AGENTS.md](https://agents.md/) format - a simple, open format for guiding AI coding agents used by over 60k open-source projects.

When you run `npx agent-orchestration init`, it creates an `AGENTS.md` file that works with:
- OpenAI Codex
- Google Jules
- Cursor
- Aider
- Windsurf
- VS Code Copilot
- And many more!

## Troubleshooting

### Server won't start

1. Make sure Node.js 18+ is installed: `node --version`
2. Check the path in your MCP config is correct

### Database errors

The SQLite database is created automatically in `.agent-orchestration/`. If corrupted:

```bash
rm -rf .agent-orchestration/
```

It will be recreated on next server start.

### Agents not seeing each other

- Ensure all agents are using the same `cwd` in the MCP config
- Check `agent_list` to see registered agents
- Stale agents are auto-cleaned after 5 minutes of no heartbeat

## Development

For contributors and local development:

### Prerequisites

- Node.js 18 or higher
- npm

### Setup

```bash
# Clone the repository
git clone https://github.com/madebyaris/agent-orchestration.git
cd agent-orchestration

# Install dependencies
npm install

# Build the project
npm run build

# Watch mode (rebuild on changes)
npm run dev

# Clean build
npm run clean && npm run build
```

## Roadmap

We're actively developing new features. Here's what's coming:

- [x] **Research-First Workflow** - Agents research and prepare before coding (DONE in v0.5.2)
- [ ] **External Memory Integration** - Integration with external memory providers like [Mem0](https://mem0.ai/), [Byteover](https://www.byterover.dev/), and our own memory solution
- [ ] **Enhanced Sub-Agent Knowledge** - Fix limitations in knowledge sharing between main agent and sub-agents
- [ ] **Graceful Error Handling** - Better error handling and recovery across all operations
- [ ] **Auto Documentation** - Automatically generate documentation from and for each sub-agent + main agent interactions

Have a feature request? [Open an issue](https://github.com/madebyaris/agent-orchestration/issues)!

## Author

**Aris Setiawan** - [madebyaris.com](https://madebyaris.com)

- GitHub: [@madebyaris](https://github.com/madebyaris)
- Repository: [agent-orchestration](https://github.com/madebyaris/agent-orchestration)

## License

MIT
