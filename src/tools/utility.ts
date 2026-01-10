/**
 * Utility tools (bootstrap, claim_todo)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../database.js';
import { AgentRole, AgentStatus, TaskComplexity, TaskPriority, TaskStatus, RESEARCH_REQUIREMENTS } from '../models.js';
import {
  getCurrentAgentId,
  setCurrentAgent,
} from './agent.js';
import { syncToActiveContext } from '../utils/contextSync.js';

export function registerUtilityTools(server: McpServer): void {
  // bootstrap
  server.tool(
    'bootstrap',
    'Initialize agent session: register (if needed), get current focus, pending tasks, and recent decisions. Call this once at the start of your session.',
    {
      name: z
        .string()
        .optional()
        .describe('Agent name. If not provided, uses env MCP_ORCH_AGENT_NAME or generates one.'),
      role: z
        .enum(['main', 'sub'])
        .optional()
        .default('sub')
        .describe("Agent role. Defaults to env MCP_ORCH_AGENT_ROLE or 'sub'."),
    },
    async ({ name, role }) => {
      const db = getDatabase();

      // Get or generate agent name
      let agentName = name ?? process.env.MCP_ORCH_AGENT_NAME;
      if (!agentName) {
        agentName = `agent-${Date.now()}`;
      }

      const agentRole =
        role === 'main'
          ? AgentRole.MAIN
          : role === 'sub'
            ? AgentRole.SUB
            : process.env.MCP_ORCH_AGENT_ROLE === 'main'
              ? AgentRole.MAIN
              : AgentRole.SUB;

      const capabilities = (process.env.MCP_ORCH_CAPABILITIES ?? 'code').split(',');

      // Check if agent already exists
      let agent = db.getAgentByName(agentName);

      if (agent) {
        // Reconnect
        setCurrentAgent(agent.id, agent.name);
        db.updateAgentHeartbeat(agent.id, AgentStatus.ACTIVE);
      } else {
        // Register new
        agent = db.createAgent({
          name: agentName,
          role: agentRole,
          capabilities,
          status: AgentStatus.ACTIVE,
        });
        setCurrentAgent(agent.id, agent.name);
      }

      // Get current context
      const focusEntry = db.getMemory('current_focus', 'context');
      const focusText = focusEntry ? String(focusEntry.value) : 'Not set';

      // Get pending tasks for this agent
      const myTasks = db.listTasks({ assignedTo: agent.id });
      const pendingTasks = myTasks.filter((t) =>
        ['pending', 'assigned'].includes(t.status)
      );

      // Get recent decisions
      const decisions = db.listMemory('decisions');

      // Sync context
      syncToActiveContext();

      const lines: string[] = [
        '# Session Initialized',
        '',
        `**Agent**: ${agent.name} (\`${agent.id}\`)`,
        `**Role**: ${agent.role}`,
        '',
        '## Current Focus',
        focusText,
        '',
        '## Your Pending Tasks',
      ];

      if (pendingTasks.length > 0) {
        for (const t of pendingTasks.slice(0, 5)) {
          lines.push(`- ${t.title} (\`${t.id.slice(0, 8)}...\`)`);
        }
      } else {
        lines.push('_No tasks assigned to you._');
      }

      lines.push('', '## Recent Decisions');

      if (decisions.length > 0) {
        for (const d of decisions.slice(0, 5)) {
          lines.push(`- **${d.key}**: ${String(d.value).slice(0, 80)}`);
        }
      } else {
        lines.push('_No decisions recorded._');
      }

      lines.push('', '---', 'Use `is_my_turn` to check for available work.');

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // claim_todo
  server.tool(
    'claim_todo',
    'FOR SUB-AGENTS: Register yourself AND claim a specific task in one call. Use this when you were spawned to work on a specific todo. This creates the task if it doesn\'t exist. Shows research checklist based on complexity.',
    {
      title: z.string().describe('The title of the todo/task you were spawned to work on'),
      description: z.string().optional().default('').describe('Additional details about the task'),
      priority: z
        .enum(['low', 'normal', 'high', 'urgent'])
        .optional()
        .default('normal')
        .describe('Priority level'),
      complexity: z
        .enum(['trivial', 'simple', 'moderate', 'complex'])
        .optional()
        .describe('Task complexity (auto-detected if not provided). Determines research requirements.'),
    },
    async ({ title, description, priority, complexity }) => {
      const db = getDatabase();

      // Generate agent name
      const agentName = `sub-${Date.now()}`;

      // Register as sub-agent
      const agent = db.createAgent({
        name: agentName,
        role: AgentRole.SUB,
        capabilities: ['code'],
        status: AgentStatus.ACTIVE, // Active, not busy yet (need to do research first)
      });
      setCurrentAgent(agent.id, agent.name);

      // Check if a task with this title already exists and is pending
      const allTasks = db.listTasks();
      let task = allTasks.find(
        (t) =>
          t.title.toLowerCase().trim() === title.toLowerCase().trim() &&
          ['pending', 'assigned'].includes(t.status)
      );

      let isNewTask = false;
      if (task) {
        // Assign the existing task to this agent (but don't start yet if research needed)
        task = db.updateTask(task.id, {
          assignedTo: agent.id,
          status: TaskStatus.ASSIGNED,
        })!;
      } else {
        // Create a new task (assigned, not in_progress)
        isNewTask = true;
        task = db.createTask({
          title,
          description,
          priority: priority as TaskPriority,
          complexity: complexity as TaskComplexity | undefined,
          status: TaskStatus.ASSIGNED,
          assignedTo: agent.id,
          createdBy: agent.id,
        });
      }

      // Sync context
      syncToActiveContext();

      // Get research requirements
      const requirements = RESEARCH_REQUIREMENTS[task.complexity];
      const researchStatus = db.getResearchStatus(task.id);

      const lines: string[] = [
        '# Task Claimed',
        '',
        `**You are**: ${agent.name} (\`${agent.id}\`)`,
        `**Working on**: ${task.title}`,
        `**Task ID**: \`${task.id}\``,
        `**Complexity**: ${task.complexity}`,
        '',
      ];

      // Show research checklist based on complexity
      if (requirements.length === 0) {
        // Trivial task - no research needed
        lines.push('## ✅ No Research Required');
        lines.push('');
        lines.push('This is a trivial task. You can start working immediately.');
        lines.push('');
        lines.push('**Next steps:**');
        lines.push('1. `task_claim` to start working');
        lines.push('2. `lock_acquire` on any files you edit');
        lines.push('3. Implement the solution');
        lines.push('4. `task_complete` when done');
        lines.push('5. `agent_unregister` when finished');
      } else if (researchStatus.isReady) {
        // Research already done
        lines.push('## ✅ Research Complete');
        lines.push('');
        lines.push('Research has already been documented. You can start working.');
        lines.push('');
        lines.push('**Next steps:**');
        lines.push('1. `task_claim` to start working');
        lines.push('2. `lock_acquire` on any files you edit');
        lines.push('3. Implement the solution');
        lines.push('4. `task_complete` when done');
      } else {
        // Research needed
        lines.push('## 🔬 Research Required');
        lines.push('');
        lines.push('Before implementing, document your research:');
        lines.push('');

        const descriptions: Record<string, string> = {
          context: 'Understand the current state, existing patterns, and project context',
          files: 'Identify all files that will be affected by this change',
          requirements: 'Document specs, acceptance criteria, and edge cases',
          design: 'Make architecture decisions and document component structure',
        };

        for (const req of requirements) {
          const done = researchStatus.completed.includes(req);
          const emoji = done ? '✅' : '⬜';
          lines.push(`${emoji} **${req}**: ${descriptions[req] || req}`);
        }

        lines.push('');
        lines.push('### How to Document Research');
        lines.push('');
        lines.push('Use `memory_set` for each item:');
        lines.push('```');
        lines.push('memory_set:');
        lines.push('  key: "<finding_name>"');
        lines.push('  value: "<your findings>"');
        lines.push(`  namespace: "research:${task.id}:<category>"`);
        lines.push('```');
        lines.push('');
        lines.push('### When Done');
        lines.push('');
        lines.push('1. Mark research complete:');
        lines.push('```');
        lines.push(`research_ready task_id="${task.id}"`);
        lines.push('```');
        lines.push('');
        lines.push('2. Then claim to start implementation:');
        lines.push('```');
        lines.push(`task_claim task_id="${task.id}"`);
        lines.push('```');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );
}
