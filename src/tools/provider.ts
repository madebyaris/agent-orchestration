import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../database.js';
import { getCurrentAgentId } from './agent.js';
import { syncToActiveContext } from '../utils/contextSync.js';
import { CursorProvider, getCursorMetadata } from '../providers/cursor.js';
import { TaskStatus } from '../models.js';
import { getDelegationDisplayStatus } from '../utils/cursorCli.js';
import {
  listDelegationKnowledge,
  writeDelegationBrief,
  writeDelegationHandoff,
} from '../utils/delegationKnowledge.js';
import { getRecoveryDisplayLine } from '../utils/delegationRecovery.js';
import { generateTaskDocumentation } from '../utils/autoDocumentation.js';
import { getTaskDelegationContext, recoverDelegatedTask, syncDelegatedTask } from '../utils/delegatedTaskRuntime.js';

function toDecisionValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function registerProviderTools(server: McpServer): void {
  server.tool(
    'cursor_task_status',
    'Show the latest health, recovery state, and hints for a delegated Cursor task.',
    {
      task_id: z.string().describe('Task ID to inspect'),
    },
    async ({ task_id }) => {
      const task = await syncDelegatedTask({
        db: getDatabase(),
        taskId: task_id,
        persistKnowledge: true,
        createdBy: getCurrentAgentId(),
      });
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      const metadata = getCursorMetadata(task.metadata);
      if (!metadata) {
        return { content: [{ type: 'text', text: `Task ${task_id} is not delegated to Cursor.` }] };
      }

      const lines = [
        '# Cursor Task Status',
        '',
        `**Task**: ${task.title}`,
        `**Task status**: ${task.status}`,
        `**Provider status**: ${metadata.providerStatus}`,
        `**Recovery**: ${getRecoveryDisplayLine(metadata)}`,
        `**Chat ID**: ${metadata.providerChatId ?? 'Unavailable'}`,
        `**Retry count**: ${metadata.providerRetryCount ?? 0}`,
      ];

      if (metadata.providerLastError) {
        lines.push('', '## Last Error', metadata.providerLastError);
      }

      if (metadata.providerRecoveryHints && metadata.providerRecoveryHints.length > 0) {
        lines.push('', '## Recovery Hints');
        for (const hint of metadata.providerRecoveryHints) {
          lines.push(`- ${hint}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'cursor_check',
    'Check whether Cursor CLI is installed and which orchestration features are available.',
    {},
    async () => {
      const result = await new CursorProvider().check();
      const lines = [
        '# Cursor Provider Check',
        '',
        `**Available**: ${result.available ? 'Yes' : 'No'}`,
        `**Binary**: ${result.binary}`,
        `**Runtime**: ${result.runtime}`,
        `**Version**: ${result.version ?? 'Unknown'}`,
        `**Features**: ${result.features.length > 0 ? result.features.join(', ') : 'None detected'}`,
      ];

      if (result.warnings.length > 0) {
        lines.push('', '## Warnings');
        for (const warning of result.warnings) {
          lines.push(`- ${warning}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'cursor_delegate_task',
    'Delegate a task to Cursor CLI and store session metadata for later resume/sync.',
    {
      task_id: z.string().describe('Task ID to delegate'),
      mode: z.enum(['agent', 'plan', 'ask']).optional().describe('Cursor execution mode'),
      model: z.string().optional().describe('Optional Cursor model'),
      use_worktree: z.boolean().optional().describe('Override worktree policy'),
      cloud: z.boolean().optional().default(false).describe('Run using Cursor cloud mode'),
      force: z.boolean().optional().describe('Allow unattended execution with approvals pre-accepted'),
    },
    async ({ task_id, mode, model, use_worktree, cloud, force }) => {
      const context = getTaskDelegationContext(getDatabase(), task_id);
      if (!context) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }
      const { task, currentFocus, decisions, research } = context;
      const db = getDatabase();

      const check = await new CursorProvider().check();
      if (!check.available) {
        return { content: [{ type: 'text', text: check.warnings.join('\n') || 'Cursor CLI is not available.' }] };
      }

      const delegated = await new CursorProvider().spawnTask({
        cwd: process.cwd(),
        task,
        currentFocus,
        decisions,
        research,
        mode,
        model,
        useWorktree: use_worktree,
        cloud,
        force,
        spawnedBy: getCurrentAgentId(),
      });

      const updated = db.updateTask(task.id, {
        status: TaskStatus.IN_PROGRESS,
        metadata: delegated.metadata,
      });

      if (updated) {
        writeDelegationBrief({
          db,
          task: updated,
          currentFocus,
          decisions,
          research,
          metadata: delegated.metadata,
          createdBy: getCurrentAgentId(),
        });
        generateTaskDocumentation(db, updated.id);
      }
      syncToActiveContext();

      const lines = [
        '# Cursor Task Delegated',
        '',
        `**Task**: ${task.title}`,
        `**Task ID**: \`${task.id}\``,
        `**Provider status**: ${delegated.metadata.providerStatus}`,
        `**Mode**: ${delegated.metadata.providerMode}`,
        `**Chat ID**: ${delegated.metadata.providerChatId ?? 'Unavailable'}`,
        `**Worktree**: ${delegated.metadata.providerWorktree ? 'Yes' : 'No'}`,
        `**Run log**: ${delegated.metadata.providerLogPath ?? 'Unavailable'}`,
        '',
        '## Launch Command',
        delegated.command,
      ];

      if (delegated.warnings.length > 0) {
        lines.push('', '## Warnings');
        for (const warning of delegated.warnings) {
          lines.push(`- ${warning}`);
        }
      }

      if (updated?.output) {
        lines.push('', '## Latest Output', updated.output);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'cursor_resume_task',
    'Return the Cursor resume command for a delegated task and refresh its last known status.',
    {
      task_id: z.string().describe('Task ID to resume'),
    },
    async ({ task_id }) => {
      const task = await syncDelegatedTask({
        db: getDatabase(),
        taskId: task_id,
        createdBy: getCurrentAgentId(),
      });
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      const metadata = getCursorMetadata(task.metadata);
      if (!metadata) {
        return { content: [{ type: 'text', text: `Task ${task_id} is not delegated to Cursor.` }] };
      }

      const context = getTaskDelegationContext(getDatabase(), task_id);
      if (!context) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      const resumed = await new CursorProvider().resumeSession({
        cwd: process.cwd(),
        task: context.task,
        currentFocus: context.currentFocus,
        decisions: context.decisions,
        research: context.research,
        delegationKnowledge: context.knowledge,
        metadata,
      });

      const lines = [
        '# Cursor Resume',
        '',
        `**Task**: ${task.title}`,
        `**Provider status**: ${metadata.providerStatus}`,
        `**Chat ID**: ${metadata.providerChatId ?? 'Unavailable'}`,
        '',
        '## Resume Command',
        resumed.command,
      ];

      if (resumed.prompt) {
        lines.push('', '## Resume Prompt', resumed.prompt);
      }

      if (resumed.warnings.length > 0) {
        lines.push('', '## Warnings');
        for (const warning of resumed.warnings) {
          lines.push(`- ${warning}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'cursor_sync_task',
    'Refresh a delegated Cursor task, sync the latest provider status, and persist knowledge back into shared memory.',
    {
      task_id: z.string().describe('Task ID to sync'),
    },
    async ({ task_id }) => {
      const task = await syncDelegatedTask({
        db: getDatabase(),
        taskId: task_id,
        persistKnowledge: true,
        createdBy: getCurrentAgentId(),
      });
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      const metadata = getCursorMetadata(task.metadata);
      if (!metadata) {
        return { content: [{ type: 'text', text: `Task ${task_id} is not delegated to Cursor.` }] };
      }

      const knowledge = listDelegationKnowledge(getDatabase(), task.id);
      const lines = [
        '# Cursor Task Synced',
        '',
        `**Task**: ${task.title}`,
        `**Provider status**: ${metadata.providerStatus}`,
        `**Chat ID**: ${metadata.providerChatId ?? 'Unavailable'}`,
        `**Task status**: ${task.status}`,
        '',
        '## Knowledge Namespaces',
        `- \`delegation:${task.id}:brief\` (${knowledge.brief.length} entries)`,
        `- \`delegation:${task.id}:updates\` (${knowledge.updates.length} entries)`,
        `- \`delegation:${task.id}:findings\` (${knowledge.findings.length} entries)`,
        `- \`delegation:${task.id}:decisions\` (${knowledge.decisions.length} entries)`,
        `- \`delegation:${task.id}:handoff\` (${knowledge.handoff.length} entries)`,
      ];

      if (task.output) {
        lines.push('', '## Latest Output', task.output);
      }

      const generated = generateTaskDocumentation(getDatabase(), task.id);
      if (generated) {
        lines.push('', '## Documentation', generated.taskDocPath);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'cursor_handoff_task',
    'Write a structured handoff for a delegated Cursor task so the next agent can resume with shared context.',
    {
      task_id: z.string().describe('Task ID to hand off'),
      summary: z.string().describe('High-level handoff summary'),
      findings: z.array(z.string()).optional().default([]).describe('Important findings discovered so far'),
      next_steps: z.array(z.string()).optional().default([]).describe('Recommended next steps'),
      blockers: z.array(z.string()).optional().default([]).describe('Known blockers or risks'),
    },
    async ({ task_id, summary, findings, next_steps, blockers }) => {
      const task = await syncDelegatedTask({
        db: getDatabase(),
        taskId: task_id,
        persistKnowledge: true,
        createdBy: getCurrentAgentId(),
      });
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      const metadata = getCursorMetadata(task.metadata);
      if (!metadata) {
        return { content: [{ type: 'text', text: `Task ${task_id} is not delegated to Cursor.` }] };
      }

      writeDelegationHandoff({
        db: getDatabase(),
        taskId: task.id,
        summary,
        findings,
        nextSteps: next_steps,
        blockers,
        createdBy: getCurrentAgentId(),
      });
      const generated = generateTaskDocumentation(getDatabase(), task.id);
      syncToActiveContext();

      const lines = [
        '# Cursor Handoff Recorded',
        '',
        `**Task**: ${task.title}`,
        `**Provider status**: ${metadata.providerStatus}`,
        `**Summary**: ${summary}`,
      ];

      if (findings.length > 0) {
        lines.push('', '## Findings');
        for (const finding of findings) {
          lines.push(`- ${finding}`);
        }
      }

      if (next_steps.length > 0) {
        lines.push('', '## Next Steps');
        for (const step of next_steps) {
          lines.push(`- ${step}`);
        }
      }

      if (blockers.length > 0) {
        lines.push('', '## Blockers');
        for (const blocker of blockers) {
          lines.push(`- ${blocker}`);
        }
      }

      if (generated) {
        lines.push('', '## Documentation', generated.taskDocPath);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'cursor_recover_task',
    'Recover a failed or stale delegated Cursor task by relaunching it with the latest shared context.',
    {
      task_id: z.string().describe('Task ID to recover'),
      mode: z.enum(['agent', 'plan', 'ask']).optional().describe('Override the recovery mode'),
      model: z.string().optional().describe('Optional Cursor model override'),
      use_worktree: z.boolean().optional().describe('Override worktree policy during recovery'),
      cloud: z.boolean().optional().describe('Override cloud mode during recovery'),
      force: z.boolean().optional().default(false).describe('Recover even if the current run still looks healthy'),
    },
    async ({ task_id, mode, model, use_worktree, cloud, force }) => {
      const result = await recoverDelegatedTask({
        db: getDatabase(),
        taskId: task_id,
        createdBy: getCurrentAgentId(),
        options: {
          mode,
          model,
          useWorktree: use_worktree,
          cloud,
          force,
        },
      });

      if (!result) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      if (result.blocked) {
        return {
          content: [{ type: 'text', text: result.reason ?? 'Recovery blocked.' }],
        };
      }

      const lines = [
        '# Cursor Task Recovered',
        '',
        `**Task**: ${result.task.title}`,
        `**Provider status**: ${result.metadata.providerStatus}`,
        `**Recovery state**: ${result.metadata.providerRecoveryState ?? 'healthy'}`,
        `**Retry count**: ${result.metadata.providerRetryCount ?? 0}`,
        `**Chat ID**: ${result.metadata.providerChatId ?? 'Unavailable'}`,
      ];

      if (result.delegated) {
        lines.push('', '## Launch Command', result.delegated.command);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.tool(
    'task_generate_doc',
    'Generate or refresh the Markdown documentation for a task using current orchestration state.',
    {
      task_id: z.string().describe('Task ID to document'),
    },
    async ({ task_id }) => {
      const generated = generateTaskDocumentation(getDatabase(), task_id);
      if (!generated) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      return {
        content: [
          {
            type: 'text',
            text: [
              '# Task Documentation Generated',
              '',
              `**Task doc**: ${generated.taskDocPath}`,
              `**Index**: ${generated.indexDocPath}`,
            ].join('\n'),
          },
        ],
      };
    }
  );

  server.tool(
    'cursor_list_delegations',
    'List all tasks currently delegated to Cursor, including last known status and session metadata.',
    {
      status: z.enum(['spawned', 'running', 'completed', 'failed']).optional().describe('Filter by provider status'),
    },
    async ({ status }) => {
      const db = getDatabase();
      const allTasks = db.listTasks();
      const delegated = [];

      for (const task of allTasks) {
        const metadata = getCursorMetadata(task.metadata);
        if (!metadata) {
          continue;
        }

        const synced = await syncDelegatedTask({
          db,
          taskId: task.id,
          createdBy: getCurrentAgentId(),
        });
        if (!synced) {
          continue;
        }

        const syncedMetadata = getCursorMetadata(synced.metadata);
        if (!syncedMetadata) {
          continue;
        }

        if (status && syncedMetadata.providerStatus !== status) {
          continue;
        }

        delegated.push({ task: synced, metadata: syncedMetadata });
      }

      if (delegated.length === 0) {
        return { content: [{ type: 'text', text: 'No Cursor delegations found.' }] };
      }

      const lines = ['# Cursor Delegations', ''];
      for (const entry of delegated) {
        lines.push(`- **${entry.task.title}** (\`${entry.task.id.slice(0, 8)}...\`)`);
        lines.push(`  ${getDelegationDisplayStatus(entry.metadata)}`);
        lines.push(`  recovery=${getRecoveryDisplayLine(entry.metadata)}`);
        lines.push(`  chat=${entry.metadata.providerChatId ?? 'n/a'} model=${entry.metadata.providerModel ?? 'default'}`);
        if (entry.task.output) {
          lines.push(`  output=${toDecisionValue(entry.task.output).slice(0, 140)}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );
}
