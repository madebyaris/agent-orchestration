/**
 * Research workflow tools
 * 
 * These tools implement the Research-First Workflow, ensuring agents
 * properly understand context, requirements, and design before implementation.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../database.js';
import { TaskComplexity, RESEARCH_REQUIREMENTS } from '../models.js';
import { getCurrentAgentId } from './agent.js';

export function registerResearchTools(server: McpServer): void {
  // research_ready
  server.tool(
    'research_ready',
    'Mark research as complete for a task. Validates that all required research items are documented based on task complexity. Call this before starting implementation.',
    {
      task_id: z.string().describe('The task ID to mark as research-ready'),
    },
    async ({ task_id }) => {
      const db = getDatabase();
      const result = db.markResearchReady(task_id);

      if (!result.success) {
        return {
          content: [{ type: 'text', text: `❌ ${result.message}` }],
        };
      }

      const lines = [
        '# ✅ Research Complete',
        '',
        `**Task**: ${result.task?.title}`,
        `**Complexity**: ${result.task?.complexity}`,
        '',
        'You may now proceed with implementation.',
        '',
        'Next steps:',
        '1. `task_claim` to start working',
        '2. `lock_acquire` on files you\'ll edit',
        '3. Implement the solution',
        '4. `task_complete` when done',
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // research_status
  server.tool(
    'research_status',
    'Check research progress for a task. Shows what research is required, completed, and missing based on task complexity.',
    {
      task_id: z.string().describe('The task ID to check research status for'),
    },
    async ({ task_id }) => {
      const db = getDatabase();
      const status = db.getResearchStatus(task_id);

      if (!status.task) {
        return {
          content: [{ type: 'text', text: `Task ${task_id} not found.` }],
        };
      }

      const task = status.task;
      const lines = [
        '# Research Status',
        '',
        `**Task**: ${task.title}`,
        `**Complexity**: ${task.complexity}`,
        `**Research Ready**: ${task.researchReady ? '✅ Yes' : '❌ No'}`,
        '',
      ];

      if (status.required.length === 0) {
        lines.push('_No research required for trivial tasks._');
      } else {
        lines.push('## Checklist');
        lines.push('');

        for (const item of status.required) {
          const done = status.completed.includes(item);
          const emoji = done ? '✅' : '⬜';
          const namespace = `research:${task_id}:${item}`;
          lines.push(`${emoji} **${item}** - \`${namespace}\``);
        }

        if (status.missing.length > 0) {
          lines.push('');
          lines.push('## How to Complete');
          lines.push('');
          lines.push('Use `memory_set` to document each missing item:');
          lines.push('');
          lines.push('```');
          lines.push('memory_set:');
          lines.push(`  key: "<finding_name>"`);
          lines.push(`  value: "<your findings>"`);
          lines.push(`  namespace: "research:${task_id}:${status.missing[0]}"`);
          lines.push('```');
        }
      }

      // Show existing research
      const research = db.getTaskResearch(task_id);
      const categories = Object.keys(research);
      
      if (categories.length > 0) {
        lines.push('');
        lines.push('## Documented Research');
        
        for (const category of categories) {
          lines.push('');
          lines.push(`### ${category}`);
          for (const entry of research[category]) {
            const valueStr = typeof entry.value === 'string' 
              ? entry.value.slice(0, 100) 
              : JSON.stringify(entry.value).slice(0, 100);
            lines.push(`- **${entry.key}**: ${valueStr}${valueStr.length >= 100 ? '...' : ''}`);
          }
        }
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // research_query
  server.tool(
    'research_query',
    'Search past research findings across all tasks. Useful for finding relevant context from previous work.',
    {
      query: z.string().describe('Search term to find in research findings'),
      limit: z.number().optional().default(10).describe('Maximum results to return'),
    },
    async ({ query, limit }) => {
      const db = getDatabase();
      const results = db.searchResearch(query, limit);

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No research findings match "${query}".` }],
        };
      }

      const lines = [
        `# Research Results for "${query}"`,
        '',
        `Found ${results.length} result(s):`,
        '',
      ];

      for (const entry of results) {
        // Parse namespace to get task ID and category
        const parts = entry.namespace.split(':');
        const taskId = parts[1] || 'unknown';
        const category = parts[2] || 'unknown';

        const valueStr = typeof entry.value === 'string'
          ? entry.value.slice(0, 150)
          : JSON.stringify(entry.value).slice(0, 150);

        lines.push(`### ${entry.key}`);
        lines.push(`- **Task**: \`${taskId.slice(0, 8)}...\``);
        lines.push(`- **Category**: ${category}`);
        lines.push(`- **Value**: ${valueStr}${valueStr.length >= 150 ? '...' : ''}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // research_checklist
  server.tool(
    'research_checklist',
    'Get the research checklist for a specific complexity level. Shows what needs to be documented before implementation.',
    {
      complexity: z
        .enum(['trivial', 'simple', 'moderate', 'complex'])
        .optional()
        .describe('Complexity level. If omitted, shows all levels.'),
    },
    async ({ complexity }) => {
      const lines = ['# Research Checklists', ''];

      const levels = complexity
        ? [complexity as TaskComplexity]
        : [TaskComplexity.TRIVIAL, TaskComplexity.SIMPLE, TaskComplexity.MODERATE, TaskComplexity.COMPLEX];

      for (const level of levels) {
        const requirements = RESEARCH_REQUIREMENTS[level];
        lines.push(`## ${level.charAt(0).toUpperCase() + level.slice(1)}`);
        lines.push('');

        if (requirements.length === 0) {
          lines.push('_No research required - can proceed directly to implementation._');
        } else {
          for (const req of requirements) {
            const descriptions: Record<string, string> = {
              context: 'Understand the current state, existing patterns, and project context',
              files: 'Identify all files that will be affected by this change',
              requirements: 'Document specs, acceptance criteria, and edge cases',
              design: 'Make architecture decisions and document component structure',
            };
            lines.push(`- **${req}**: ${descriptions[req] || req}`);
          }
        }
        lines.push('');
      }

      lines.push('---');
      lines.push('');
      lines.push('Use `memory_set` with namespace `research:<task_id>:<category>` to document each item.');

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );
}
