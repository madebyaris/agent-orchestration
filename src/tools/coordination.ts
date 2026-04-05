/**
 * Coordination tools (locks and status)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../database.js';
import { EventType, TaskStatus } from '../models.js';
import { getCurrentAgentId } from './agent.js';
import { syncToActiveContext } from '../utils/contextSync.js';

export function registerCoordinationTools(server: McpServer): void {
  // lock_acquire
  server.tool(
    'lock_acquire',
    'Acquire a lock on a resource to prevent concurrent access.',
    {
      resource: z.string().describe("The resource to lock (file path, 'namespace:key', etc.)"),
      timeout_seconds: z
        .number()
        .optional()
        .default(300)
        .describe('Lock timeout. Auto-releases after this time.'),
      reason: z.string().optional().describe('Why you need this lock'),
    },
    async ({ resource, timeout_seconds, reason }) => {
      const agentId = getCurrentAgentId();
      if (!agentId) {
        return {
          content: [{ type: 'text', text: 'Error: Not registered.' }],
        };
      }

      const db = getDatabase();

      // Check if already locked
      const existing = db.checkLock(resource);
      if (existing) {
        if (existing.heldBy === agentId) {
          return {
            content: [{ type: 'text', text: 'You already hold this lock.' }],
          };
        }
        return {
          content: [{ type: 'text', text: `Lock denied: held by ${existing.heldBy}` }],
        };
      }

      const lock = db.acquireLock({
        resource,
        heldBy: agentId,
        timeoutSeconds: timeout_seconds,
        metadata: { reason: reason ?? '' },
      });

      if (lock) {
        // Keep activeContext.md up-to-date (if enabled)
        syncToActiveContext();
        return {
          content: [
            {
              type: 'text',
              text: `Lock acquired on '${resource}' (expires in ${timeout_seconds}s)`,
            },
          ],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to acquire lock.' }],
      };
    }
  );

  // lock_release
  server.tool(
    'lock_release',
    'Release a lock you are holding.',
    {
      resource: z.string().describe('The resource to unlock'),
    },
    async ({ resource }) => {
      const agentId = getCurrentAgentId();
      if (!agentId) {
        return {
          content: [{ type: 'text', text: 'Error: Not registered.' }],
        };
      }

      const released = getDatabase().releaseLock(resource, agentId);

      if (released) {
        // Keep activeContext.md up-to-date (if enabled)
        syncToActiveContext();
        return {
          content: [{ type: 'text', text: 'Lock released.' }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Could not release lock. You may not hold it.' }],
      };
    }
  );

  // lock_check
  server.tool(
    'lock_check',
    'Check if a resource is currently locked.',
    {
      resource: z.string().describe('The resource to check'),
    },
    async ({ resource }) => {
      const agentId = getCurrentAgentId();
      const lock = getDatabase().checkLock(resource);

      if (lock) {
        const isYou = lock.heldBy === agentId ? ' (you)' : '';
        return {
          content: [{ type: 'text', text: `Locked by ${lock.heldBy}${isYou}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Not locked.' }],
      };
    }
  );

  // coordination_status
  server.tool(
    'coordination_status',
    'Get overall coordination status: active agents, pending tasks, held locks.',
    {},
    async () => {
      const db = getDatabase();

      // Cleanup stale agents so status is accurate
      db.cleanupStaleAgents();

      const agents = db.listAgents();
      const active = agents.filter((a) => ['active', 'busy'].includes(a.status));
      const pending = db.listTasks({ status: TaskStatus.PENDING });
      const inProgress = db.listTasks({ status: TaskStatus.IN_PROGRESS });
      const stats = db.getStats();

      const lines = [
        '# Coordination Status\n',
        `**Agents**: ${active.length} active / ${agents.length} total`,
        `**Tasks**: ${pending.length} pending, ${inProgress.length} in progress`,
        `**Locks**: ${stats.locks} active`,
        `**Memory**: ${stats.memory} entries`,
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // event_list
  server.tool(
    'event_list',
    'List recent orchestration events (who did what, when). Useful for debugging coordination.',
    {
      agent_id: z.string().optional().describe('Filter by agent ID'),
      event_type: z
        .enum([
          'agent_registered',
          'agent_unregistered',
          'agent_heartbeat',
          'task_created',
          'task_assigned',
          'task_claimed',
          'task_updated',
          'task_completed',
          'memory_set',
          'memory_delete',
          'lock_acquired',
          'lock_released',
        ])
        .optional()
        .describe('Filter by event type'),
      limit: z.number().optional().default(50).describe('Maximum events to return'),
    },
    async ({ agent_id, event_type, limit }) => {
      const db = getDatabase();
      const events = db.listEvents({
        agentId: agent_id,
        eventType: event_type as EventType | undefined,
        limit,
      });

      if (events.length === 0) {
        return { content: [{ type: 'text', text: 'No events found.' }] };
      }

      const lines: string[] = ['# Recent Events', ''];
      for (const e of events) {
        const agent = e.agentId ? ` agent=${e.agentId.slice(0, 8)}...` : '';
        const resource = e.resourceId ? ` resource=${String(e.resourceId).slice(0, 60)}` : '';
        const details =
          e.details && Object.keys(e.details).length > 0 ? ` details=${JSON.stringify(e.details).slice(0, 120)}` : '';
        lines.push(`- ${e.timestamp.toISOString()} ${e.eventType}${agent}${resource}${details}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );
}
