import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../database.js';
import { getCurrentAgentId } from './agent.js';
import { syncToActiveContext } from '../utils/contextSync.js';
import { CursorProvider, getCursorMetadata, getTaskStatusForDelegation } from '../providers/cursor.js';
import { TaskStatus } from '../models.js';
import { getDelegationDisplayStatus } from '../utils/cursorCli.js';

function toDecisionValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function syncDelegatedTask(taskId: string) {
  const db = getDatabase();
  const task = db.getTask(taskId);
  if (!task) {
    return null;
  }

  const metadata = getCursorMetadata(task.metadata);
  if (!metadata) {
    return task;
  }

  const provider = new CursorProvider();
  return provider.syncTask(metadata).then((result) => {
    const nextStatus = getTaskStatusForDelegation(result.metadata);
    const updates: {
      metadata: Record<string, unknown>;
      status?: TaskStatus;
      output?: string;
    } = {
      metadata: result.metadata,
    };

    if (result.outputSummary && (!task.output || result.finished)) {
      updates.output = result.outputSummary;
    }

    if (nextStatus && ![TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED].includes(task.status)) {
      updates.status = nextStatus;
    }

    const updated = db.updateTask(task.id, updates);
    syncToActiveContext();
    return updated;
  });
}

export function registerProviderTools(server: McpServer): void {
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
      const db = getDatabase();
      const task = db.getTask(task_id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      const check = await new CursorProvider().check();
      if (!check.available) {
        return { content: [{ type: 'text', text: check.warnings.join('\n') || 'Cursor CLI is not available.' }] };
      }

      const focus = db.getMemory('current_focus', 'context');
      const decisions = db.listMemory('decisions');
      const research = db.getTaskResearch(task.id);
      const delegated = await new CursorProvider().spawnTask({
        cwd: process.cwd(),
        task,
        currentFocus: focus ? String(focus.value) : null,
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
      const db = getDatabase();
      const task = await syncDelegatedTask(task_id);
      if (!task) {
        return { content: [{ type: 'text', text: `Task ${task_id} not found.` }] };
      }

      const metadata = getCursorMetadata(task.metadata);
      if (!metadata) {
        return { content: [{ type: 'text', text: `Task ${task_id} is not delegated to Cursor.` }] };
      }

      const resumed = await new CursorProvider().resumeSession({
        cwd: process.cwd(),
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

        const synced = await syncDelegatedTask(task.id);
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
        lines.push(`  chat=${entry.metadata.providerChatId ?? 'n/a'} model=${entry.metadata.providerModel ?? 'default'}`);
        if (entry.task.output) {
          lines.push(`  output=${toDecisionValue(entry.task.output).slice(0, 140)}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );
}
