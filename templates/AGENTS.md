# AGENTS.md

This project uses **Agent Orchestration** for multi-agent coordination.

## MCP Server Setup

Add this to your IDE's MCP configuration:

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

**Note**: Run from your project root. The server uses the current directory.

---

## First Action: Bootstrap

Before doing any work, you MUST run:

```
bootstrap
```

**Important**: `bootstrap` is an MCP **tool invocation inside your agent/IDE**, not a terminal command.

This registers you with the orchestrator and shows:
- Current project focus
- Tasks assigned to you
- Recent decisions

---

## If You Have a Specific Task

If you were given a specific task to work on, run:

```
claim_todo:
  title: "<the task title>"
```

This registers you AND claims the task in one call.

---

## Available Tools

### Session Management
| Tool | Description |
|------|-------------|
| `bootstrap` | Initialize session: register, get focus, tasks, decisions |
| `claim_todo` | Register + claim a task in one call |
| `agent_whoami` | Get your current agent info |

### Agent Coordination
| Tool | Description |
|------|-------------|
| `agent_register` | Register with the orchestration system |
| `agent_heartbeat` | Send heartbeat to indicate you're active |
| `agent_list` | List all registered agents |
| `agent_unregister` | Unregister (releases all locks) |

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
| `task_create` | Create a new task |
| `task_claim` | Claim a task to work on |
| `task_update` | Update task status or progress |
| `task_complete` | Mark task as completed |
| `task_list` | List tasks with filters |
| `is_my_turn` | Check if work is available |

### Resource Locking
| Tool | Description |
|------|-------------|
| `lock_acquire` | Acquire a lock on a file/resource |
| `lock_release` | Release a held lock |
| `lock_check` | Check if a resource is locked |
| `coordination_status` | Get overall system status |

---

## Workflow for Main Orchestrator

```
1. bootstrap                          # Start session
2. memory_set current_focus "..."     # Set project focus
3. task_create "Feature X"            # Create tasks
4. coordination_status                # Monitor progress
```

## Workflow for Sub-Agents

```
1. claim_todo "Feature X"             # Register + claim
2. lock_acquire "src/feature.ts"      # Lock before editing
3. [do the work]
4. task_complete <task_id> "Done"     # Complete the task
5. agent_unregister                   # Clean up
```

---

## Memory Namespaces

Use these namespaces for organization:

| Namespace | Purpose | Example Keys |
|-----------|---------|--------------|
| `context` | Current state and focus | `current_focus`, `current_branch` |
| `decisions` | Architectural decisions | `auth_strategy`, `db_choice` |
| `findings` | Analysis results | `perf_issues`, `security_audit` |
| `blockers` | Issues blocking progress | `api_down`, `missing_deps` |

---

## Coordination Patterns

### Before Editing Files
```
lock_check: { resource: "src/file.ts" }
lock_acquire: { resource: "src/file.ts", reason: "Implementing feature" }
```

### After Editing Files
```
lock_release: { resource: "src/file.ts" }
```

### Check Before Major Work
```
is_my_turn
```

### When Done
```
task_complete: { task_id: "<id>", output: "Summary of changes" }
agent_unregister
```

---

## Reference activeContext.md

Check `activeContext.md` for current project state - it's auto-updated.
