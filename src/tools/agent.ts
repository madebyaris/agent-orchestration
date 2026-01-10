/**
 * Agent management tools
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../database.js';
import { AgentRole, AgentStatus } from '../models.js';
import { syncToActiveContext } from '../utils/contextSync.js';

// Current agent state (per server instance)
let currentAgentId: string | null = null;
let currentAgentName: string | null = null;

export function getCurrentAgentId(): string | null {
  return currentAgentId;
}

export function getCurrentAgentName(): string | null {
  return currentAgentName;
}

export function setCurrentAgent(id: string, name: string): void {
  currentAgentId = id;
  currentAgentName = name;
}

export function clearCurrentAgent(): void {
  currentAgentId = null;
  currentAgentName = null;
}

export function registerAgentTools(server: McpServer): void {
  // agent_register
  server.tool(
    'agent_register',
    'Register this agent with the orchestration system. Call this at the start of your session.',
    {
      name: z.string().describe('A unique name for this agent'),
      role: z.enum(['main', 'sub']).optional().default('sub').describe('Agent role'),
      capabilities: z
        .array(z.string())
        .optional()
        .default(['code'])
        .describe('List of capabilities'),
    },
    async ({ name, role, capabilities }) => {
      const db = getDatabase();

      // Check if agent with this name already exists
      const existing = db.getAgentByName(name);
      if (existing) {
        // Reconnect to existing agent
        setCurrentAgent(existing.id, existing.name);
        db.updateAgentHeartbeat(existing.id, AgentStatus.ACTIVE);
        syncToActiveContext();
        return {
          content: [
            {
              type: 'text',
              text: `Reconnected as '${existing.name}' (${existing.id})`,
            },
          ],
        };
      }

      const agent = db.createAgent({
        name,
        role: role === 'main' ? AgentRole.MAIN : AgentRole.SUB,
        capabilities,
        status: AgentStatus.ACTIVE,
      });

      setCurrentAgent(agent.id, agent.name);
      syncToActiveContext();

      return {
        content: [
          {
            type: 'text',
            text: `Registered as '${agent.name}' (${agent.id})`,
          },
        ],
      };
    }
  );

  // agent_heartbeat
  server.tool(
    'agent_heartbeat',
    'Send a heartbeat to indicate agent is still active. Call periodically during long operations.',
    {
      status: z
        .enum(['active', 'idle', 'busy'])
        .optional()
        .describe('Current status (active, idle, busy)'),
    },
    async ({ status }) => {
      if (!currentAgentId) {
        return {
          content: [{ type: 'text', text: 'Error: Not registered. Call agent_register first.' }],
        };
      }

      const agentStatus = status
        ? (status as AgentStatus)
        : undefined;

      const updated = getDatabase().updateAgentHeartbeat(currentAgentId, agentStatus);

      if (updated) {
        syncToActiveContext();
        return {
          content: [{ type: 'text', text: `Heartbeat recorded${status ? ` (${status})` : ''}.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Error: Agent not found.' }],
      };
    }
  );

  // agent_list
  server.tool(
    'agent_list',
    'List all registered agents in the orchestration system.',
    {
      status: z
        .enum(['active', 'idle', 'busy', 'offline'])
        .optional()
        .describe('Filter by status'),
      role: z.enum(['main', 'sub']).optional().describe('Filter by role'),
    },
    async ({ status, role }) => {
      const db = getDatabase();

      // Cleanup stale agents first
      db.cleanupStaleAgents();

      const agents = db.listAgents({
        status: status as AgentStatus | undefined,
        role: role === 'main' ? AgentRole.MAIN : role === 'sub' ? AgentRole.SUB : undefined,
      });

      if (agents.length === 0) {
        return {
          content: [{ type: 'text', text: 'No agents registered.' }],
        };
      }

      const lines = ['# Registered Agents\n'];
      for (const agent of agents) {
        const isMe = agent.id === currentAgentId ? ' (you)' : '';
        const statusEmoji = {
          active: '🟢',
          idle: '🟡',
          busy: '🔵',
          offline: '⚫',
        }[agent.status];

        lines.push(`${statusEmoji} **${agent.name}**${isMe} - ${agent.role}`);
        lines.push(`   ID: \`${agent.id}\``);
        lines.push(`   Capabilities: ${agent.capabilities.join(', ') || 'none'}`);
        lines.push('');
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // agent_unregister
  server.tool(
    'agent_unregister',
    'Unregister this agent and release all held locks. Call at the end of your session.',
    {},
    async () => {
      if (!currentAgentId) {
        return {
          content: [{ type: 'text', text: 'Not registered.' }],
        };
      }

      const db = getDatabase();
      const deleted = db.deleteAgent(currentAgentId);

      if (deleted) {
        const name = currentAgentName;
        clearCurrentAgent();
        syncToActiveContext();
        return {
          content: [{ type: 'text', text: `Agent '${name}' unregistered. All locks released.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Error: Could not unregister agent.' }],
      };
    }
  );

  // agent_whoami
  server.tool(
    'agent_whoami',
    'Get information about your current agent identity.',
    {},
    async () => {
      if (!currentAgentId) {
        return {
          content: [
            {
              type: 'text',
              text: 'Not registered. Use `bootstrap` or `agent_register` to register.',
            },
          ],
        };
      }

      const agent = getDatabase().getAgent(currentAgentId);
      if (!agent) {
        clearCurrentAgent();
        return {
          content: [{ type: 'text', text: 'Agent not found in database. Registration expired.' }],
        };
      }

      const lines = [
        '# Your Agent Info',
        '',
        `**Name**: ${agent.name}`,
        `**ID**: \`${agent.id}\``,
        `**Role**: ${agent.role}`,
        `**Status**: ${agent.status}`,
        `**Capabilities**: ${agent.capabilities.join(', ') || 'none'}`,
        `**Registered**: ${agent.registeredAt.toISOString()}`,
        `**Last Heartbeat**: ${agent.lastHeartbeat.toISOString()}`,
      ];

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );
}
