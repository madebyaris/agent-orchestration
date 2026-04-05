/**
 * Shared memory tools
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../database.js';
import { getCurrentAgentId } from './agent.js';
import { syncToActiveContext } from '../utils/contextSync.js';

export function registerMemoryTools(server: McpServer): void {
  // memory_set
  server.tool(
    'memory_set',
    'Store a value in shared memory. Use namespaces to organize: context, decisions, findings, blockers.',
    {
      key: z.string().describe('The key to store the value under'),
      value: z.any().describe('The value to store (any JSON-serializable value)'),
      namespace: z
        .string()
        .optional()
        .default('default')
        .describe('Namespace for organization (context, decisions, findings, blockers)'),
      ttl_seconds: z
        .number()
        .optional()
        .describe('Time-to-live in seconds. Entry auto-deletes after this time.'),
    },
    async ({ key, value, namespace, ttl_seconds }) => {
      const agentId = getCurrentAgentId();

      const entry = getDatabase().setMemory({
        key,
        value,
        namespace,
        createdBy: agentId,
        ttlSeconds: ttl_seconds ?? null,
      });

      // Keep activeContext.md up-to-date (if enabled)
      syncToActiveContext();

      const ttlInfo = entry.ttlSeconds ? ` (expires in ${entry.ttlSeconds}s)` : '';

      return {
        content: [
          {
            type: 'text',
            text: `Stored '${key}' in namespace '${namespace}'${ttlInfo}`,
          },
        ],
      };
    }
  );

  // memory_get
  server.tool(
    'memory_get',
    'Retrieve a value from shared memory.',
    {
      key: z.string().describe('The key to retrieve'),
      namespace: z.string().optional().default('default').describe('The namespace to search in'),
    },
    async ({ key, namespace }) => {
      const entry = getDatabase().getMemory(key, namespace);

      if (!entry) {
        return {
          content: [
            {
              type: 'text',
              text: `Key '${key}' not found in namespace '${namespace}'.`,
            },
          ],
        };
      }

      const valueStr =
        typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value, null, 2);

      const lines = [
        `**${namespace}:${key}**`,
        '',
        valueStr,
        '',
        `_Updated: ${entry.updatedAt.toISOString()}_`,
      ];

      if (entry.expiresAt) {
        lines.push(`_Expires: ${entry.expiresAt.toISOString()}_`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // memory_list
  server.tool(
    'memory_list',
    'List all keys in a namespace.',
    {
      namespace: z.string().optional().default('default').describe('The namespace to list'),
    },
    async ({ namespace }) => {
      const entries = getDatabase().listMemory(namespace);

      if (entries.length === 0) {
        return {
          content: [{ type: 'text', text: `No entries in namespace '${namespace}'.` }],
        };
      }

      const lines = [`# Memory: ${namespace}\n`];

      for (const entry of entries) {
        const valuePreview =
          typeof entry.value === 'string'
            ? entry.value.slice(0, 100) + (entry.value.length > 100 ? '...' : '')
            : JSON.stringify(entry.value).slice(0, 100);

        lines.push(`- **${entry.key}**: ${valuePreview}`);
      }

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    }
  );

  // memory_delete
  server.tool(
    'memory_delete',
    'Delete a value from shared memory.',
    {
      key: z.string().describe('The key to delete'),
      namespace: z.string().optional().default('default').describe('The namespace'),
    },
    async ({ key, namespace }) => {
      const deleted = getDatabase().deleteMemory(key, namespace);

      if (deleted) {
        // Keep activeContext.md up-to-date (if enabled)
        syncToActiveContext();
        return {
          content: [{ type: 'text', text: `Deleted '${key}' from namespace '${namespace}'.` }],
        };
      }

      return {
        content: [{ type: 'text', text: `Key '${key}' not found in namespace '${namespace}'.` }],
      };
    }
  );
}
