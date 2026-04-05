/**
 * Task management tools
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../database.js';
import { TaskComplexity, TaskPriority, TaskStatus, RESEARCH_REQUIREMENTS } from '../models.js';
import { getCurrentAgentId } from './agent.js';
import { syncToActiveContext } from '../utils/contextSync.js';

export function registerTaskTools(server: McpServer): void {
  // task_create
  server.tool(
    'task_create',
    'Create a new task in the task queue. Complexity is auto-detected from title/description but can be overridden.',
    {
      title: z.string().describe('Short title for the task'),
      description: z.string().optional().default('').describe('Detailed description'),
      priority: z
        .enum(['low', 'normal', 'high', 'urgent'])
        .optional()
        .default('normal')
        .describe('Priority level'),
      complexity: z
        .enum(['trivial', 'simple', 'moderate', 'complex'])
        .optional()
        .describe('Task complexity (auto-detected if not provided). Determines research requirements.'),
      assigned_to: z.string().optional().describe('Agent ID to assign to'),
      dependencies: z
        .array(z.string())
        .optional()
        .default([])
        .describe('List of task IDs that must complete first'),
    },
    async ({ title, description, priority, complexity, assigned_to, dependencies }) => {
      const agentId = getCurrentAgentId();

      const task = getDatabase().createTask({
        title,
        description,
        priority: priority as TaskPriority,
        complexity: complexity as TaskComplexity | undefined,
        createdBy: agentId,
        assignedTo: assigned_to ?? null,
        dependencies,
      });

      // Keep activeContext.md up-to-date (if enabled)
      syncToActiveContext();

      const requirements = RESEARCH_REQUIREMENTS[task.complexity];
      const researchInfo = requirements.length > 0
        ? `\n\n**Research required** (${task.complexity}): ${requirements.join(', ')}\nUse \`research_status ${task.id}\` to see checklist.`
        : '\n\n_No research required (trivial task)._';

      return {
        content: [
          {
            type: 'text',
            text: `Task created: '${task.title}' (\`${task.id}\`)\n**Complexity**: ${task.complexity}${researchInfo}`,
          },
        ],
      };
    }
  );

  // task_claim
  server.tool(
    'task_claim',
    'Claim a task to work on it. Sets status to in_progress. Requires research to be complete for non-trivial tasks.',
    {
      task_id: z
        .string()
        .optional()
        .describe('Task ID to claim. If omitted, claims the next available task.'),
      skip_research: z
        .boolean()
        .optional()
        .default(false)
        .describe('Force claim without research (not recommended). Use only for urgent fixes.'),
    },
    async ({ task_id, skip_research }) => {
      const agentId = getCurrentAgentId();
      if (!agentId) {
        return {
          content: [{ type: 'text', text: 'Error: Not registered.' }],
        };
      }

      const db = getDatabase();
      let task;

      if (task_id) {
        task = db.getTask(task_id);
        if (!task) {
          return {
            content: [{ type: 'text', text: `Task ${task_id} not found.` }],
          };
        }
      } else {
        task = db.getNextAvailableTask(agentId);
        if (!task) {
          return {
            content: [{ type: 'text', text: 'No available tasks to claim.' }],
          };
        }
      }

      // Check dependencies
      if (!db.checkDependenciesMet(task.id)) {
        return {
          content: [{ type: 'text', text: `Cannot claim: dependencies not met.` }],
        };
      }

      // Check research gate (unless skipped or trivial)
      const requirements = RESEARCH_REQUIREMENTS[task.complexity];
      if (!skip_research && requirements.length > 0 && !task.researchReady) {
        const status = db.getResearchStatus(task.id);
        const lines = [
          '❌ **Cannot claim: Research not complete**',
          '',
          `**Task**: ${task.title}`,
          `**Complexity**: ${task.complexity}`,
          '',
          '## Required Research',
        ];

        for (const req of requirements) {
          const done = status.completed.includes(req);
          lines.push(`${done ? '✅' : '⬜'} ${req}`);
        }

        if (status.missing.length > 0) {
          lines.push('');
          lines.push('## How to Complete');
          lines.push('');
          lines.push('1. Document each missing item with `memory_set`:');
          lines.push('```');
          lines.push(`memory_set key="<finding>" value="<details>" namespace="research:${task.id}:${status.missing[0]}"`);
          lines.push('```');
          lines.push('');
          lines.push('2. Mark research complete:');
          lines.push('```');
          lines.push(`research_ready task_id="${task.id}"`);
          lines.push('```');
          lines.push('');
          lines.push('3. Then claim the task again.');
          lines.push('');
          lines.push('_Use `skip_research: true` to bypass (not recommended)._');
        }

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      }

      // Claim it
      const updated = db.updateTask(task.id, {
        status: TaskStatus.IN_PROGRESS,
        assignedTo: agentId,
      });

      if (updated) {
        // Keep activeContext.md up-to-date (if enabled)
        syncToActiveContext();

        const skippedWarning = skip_research && requirements.length > 0 && !task.researchReady
          ? '\n\n⚠️ _Research was skipped. Consider documenting findings as you work._'
          : '';

        return {
          content: [
            {
              type: 'text',
              text: `Claimed task: '${updated.title}' (\`${updated.id}\`)${skippedWarning}`,
            },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to claim task.' }],
      };
    }
  );

  // task_update
  server.tool(
    'task_update',
    'Update a task status or progress.',
    {
      task_id: z.string().describe('The task ID to update'),
      status: z
        .enum(['pending', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'])
        .optional()
        .describe('New status'),
      progress: z.number().min(0).max(100).optional().describe('Progress percentage (0-100)'),
      output: z.string().optional().describe('Output or notes'),
    },
    async ({ task_id, status, progress, output }) => {
      const db = getDatabase();
      const task = db.getTask(task_id);

      if (!task) {
        return {
          content: [{ type: 'text', text: `Task ${task_id} not found.` }],
        };
      }

      const metadata = progress !== undefined ? { progress } : undefined;

      const updated = db.updateTask(task_id, {
        status: status as TaskStatus | undefined,
        output,
        metadata,
      });

      if (updated) {
        // Keep activeContext.md up-to-date (if enabled)
        syncToActiveContext();

        const statusInfo = status ? ` → ${status}` : '';
        const progressInfo = progress !== undefined ? ` (${progress}%)` : '';

        return {
          content: [
            {
              type: 'text',
              text: `Updated task '${updated.title}'${statusInfo}${progressInfo}`,
            },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to update task.' }],
      };
    }
  );

  // task_complete
  server.tool(
    'task_complete',
    'Mark a task as completed with optional output.',
    {
      task_id: z.string().describe('The task ID to complete'),
      output: z.string().optional().describe('Summary of what was done'),
    },
    async ({ task_id, output }) => {
      const db = getDatabase();
      const task = db.getTask(task_id);

      if (!task) {
        return {
          content: [{ type: 'text', text: `Task ${task_id} not found.` }],
        };
      }

      const updated = db.updateTask(task_id, {
        status: TaskStatus.COMPLETED,
        output,
      });

      if (updated) {
        // Keep activeContext.md up-to-date (if enabled)
        syncToActiveContext();

        return {
          content: [
            {
              type: 'text',
              text: `✅ Task completed: '${updated.title}'`,
            },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to complete task.' }],
      };
    }
  );

  // task_list
  server.tool(
    'task_list',
    'List tasks with optional filters.',
    {
      status: z
        .enum(['pending', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'])
        .optional()
        .describe('Filter by status'),
      assigned_to: z.string().optional().describe('Filter by assigned agent ID'),
      mine: z.boolean().optional().describe('Show only my tasks'),
    },
    async ({ status, assigned_to, mine }) => {
      const agentId = getCurrentAgentId();
      const db = getDatabase();

      let assignee = assigned_to;
      if (mine && agentId) {
        assignee = agentId;
      }

      const tasks = db.listTasks({
        status: status as TaskStatus | undefined,
        assignedTo: assignee,
      });

      if (tasks.length === 0) {
        return {
          content: [{ type: 'text', text: 'No tasks found.' }],
        };
      }

      const lines = ['# Tasks\n'];

      for (const task of tasks) {
        const emoji = {
          pending: '⏳',
          assigned: '📋',
          in_progress: '🔄',
          completed: '✅',
          failed: '❌',
          cancelled: '🚫',
        }[task.status];

        const researchIcon = task.researchReady ? '📚' : (RESEARCH_REQUIREMENTS[task.complexity].length > 0 ? '🔬' : '');

        lines.push(`${emoji} **${task.title}** (\`${task.id.slice(0, 8)}...\`) ${researchIcon}`);
        lines.push(`   Status: ${task.status} | Complexity: ${task.complexity} | Research: ${task.researchReady ? 'ready' : 'pending'}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // is_my_turn
  server.tool(
    'is_my_turn',
    "Check if it's your turn to work on a task or if work is available.",
    {
      task_id: z
        .string()
        .optional()
        .describe('Specific task ID, or leave empty to check for any available task'),
    },
    async ({ task_id }) => {
      const agentId = getCurrentAgentId();
      if (!agentId) {
        return {
          content: [{ type: 'text', text: 'Error: Not registered.' }],
        };
      }

      const db = getDatabase();

      if (task_id) {
        const task = db.getTask(task_id);
        if (!task) {
          return {
            content: [{ type: 'text', text: `Task ${task_id} not found.` }],
          };
        }

        if (task.assignedTo !== agentId) {
          return {
            content: [
              {
                type: 'text',
                text: `No - assigned to ${task.assignedTo || 'no one'}.`,
              },
            ],
          };
        }

        if (!db.checkDependenciesMet(task_id)) {
          return {
            content: [{ type: 'text', text: 'No - waiting for dependencies.' }],
          };
        }

        if (task.status === TaskStatus.COMPLETED) {
          return {
            content: [{ type: 'text', text: 'No - already completed.' }],
          };
        }

        const requirements = RESEARCH_REQUIREMENTS[task.complexity];
        if (requirements.length > 0 && !task.researchReady) {
          return {
            content: [
              {
                type: 'text',
                text: `Yes - task is assigned to you, but research is not complete. Use research_status task_id="${task.id}" then research_ready, then task_claim.`,
              },
            ],
          };
        }

        return {
          content: [{ type: 'text', text: 'Yes - task is ready for you. Use task_claim to start.' }],
        };
      } else {
        const available = db.getNextAvailableTask(agentId);
        if (available) {
          const requirements = RESEARCH_REQUIREMENTS[available.complexity];
          if (requirements.length > 0 && !available.researchReady) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Yes - '${available.title}' is available, but research is required before you can claim it. Use research_status task_id="${available.id}" then research_ready, then task_claim.`,
                },
              ],
            };
          }
          return {
            content: [{ type: 'text', text: `Yes - '${available.title}' is available.` }],
          };
        }

        return {
          content: [{ type: 'text', text: 'No - no tasks available.' }],
        };
      }
    }
  );
}
