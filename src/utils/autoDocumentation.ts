import * as fs from 'fs';
import * as path from 'path';
import { OrchestratorDatabase } from '../database.js';
import { CursorDelegationMetadata, Event, isCursorDelegationMetadata, Task } from '../models.js';
import { listDelegationKnowledge } from './delegationKnowledge.js';
import { getRecoveryDisplayLine } from './delegationRecovery.js';

const DEFAULT_DOCS_DIR = path.join('.agent-orchestration', 'docs');

export interface GeneratedTaskDocumentation {
  taskDocPath: string;
  indexDocPath: string;
  content: string;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function formatEvent(event: Event): string {
  const details = Object.keys(event.details).length > 0 ? ` ${JSON.stringify(event.details)}` : '';
  return `- ${event.timestamp.toISOString()} ${event.eventType}${details}`;
}

function buildTaskDocumentation(db: OrchestratorDatabase, task: Task): string {
  const focus = db.getMemory('current_focus', 'context');
  const research = db.getTaskResearch(task.id);
  const knowledge = listDelegationKnowledge(db, task.id);
  const relevantEvents = db
    .listEvents({ limit: 200 })
    .filter((event) => event.resourceId === task.id)
    .slice(0, 20);

  const lines: string[] = [
    `# Task Documentation: ${task.title}`,
    '',
    `- Task ID: \`${task.id}\``,
    `- Status: ${task.status}`,
    `- Priority: ${task.priority}`,
    `- Complexity: ${task.complexity}`,
    `- Research Ready: ${task.researchReady ? 'yes' : 'no'}`,
    `- Created At: ${task.createdAt.toISOString()}`,
    `- Updated At: ${task.updatedAt.toISOString()}`,
  ];

  if (task.output) {
    lines.push('', '## Summary', '', task.output);
  }

  lines.push('', '## Current Focus', '', focus ? String(focus.value) : 'Not set.');

  if (task.dependencies.length > 0) {
    lines.push('', '## Dependencies', '');
    for (const dependency of task.dependencies) {
      lines.push(`- ${dependency}`);
    }
  }

  if (Object.keys(research).length > 0) {
    lines.push('', '## Research');
    for (const [category, entries] of Object.entries(research)) {
      lines.push('', `### ${category}`);
      for (const entry of entries) {
        lines.push(`- **${entry.key}**: ${stringifyValue(entry.value)}`);
      }
    }
  }

  if (isCursorDelegationMetadata(task.metadata)) {
    const metadata = task.metadata as CursorDelegationMetadata;
    lines.push('', '## Provider');
    lines.push(`- Provider: ${metadata.provider}`);
    lines.push(`- Status: ${metadata.providerStatus}`);
    lines.push(`- Mode: ${metadata.providerMode ?? 'agent'}`);
    lines.push(`- Chat ID: ${metadata.providerChatId ?? 'Unavailable'}`);
    lines.push(`- Recovery: ${getRecoveryDisplayLine(metadata)}`);
    lines.push(`- Retry Count: ${metadata.providerRetryCount ?? 0}`);
    if (metadata.providerLastError) {
      lines.push(`- Last Error: ${metadata.providerLastError}`);
    }
    if (metadata.providerLaunchCommand) {
      lines.push(`- Launch Command: \`${metadata.providerLaunchCommand}\``);
    }
    if (metadata.providerLogPath) {
      lines.push(`- Log Path: \`${metadata.providerLogPath}\``);
    }
  }

  const knowledgeSections = [
    ['Brief', knowledge.brief],
    ['Updates', knowledge.updates],
    ['Findings', knowledge.findings],
    ['Decisions', knowledge.decisions],
    ['Handoff', knowledge.handoff],
  ] as const;

  if (knowledgeSections.some(([, entries]) => entries.length > 0)) {
    lines.push('', '## Delegation Knowledge');
    for (const [label, entries] of knowledgeSections) {
      if (entries.length === 0) {
        continue;
      }

      lines.push('', `### ${label}`);
      for (const entry of entries) {
        lines.push(`- **${entry.key}**: ${stringifyValue(entry.value)}`);
      }
    }
  }

  lines.push('', '## Recent Events', '');
  if (relevantEvents.length === 0) {
    lines.push('_No task-specific events recorded._');
  } else {
    for (const event of relevantEvents) {
      lines.push(formatEvent(event));
    }
  }

  lines.push('', '---', '', `_Generated at ${new Date().toISOString()} by Agent Orchestration._`);
  return lines.join('\n');
}

function buildDocsIndex(db: OrchestratorDatabase): string {
  const tasks = db.listTasks();
  const lines: string[] = ['# Task Documentation Index', ''];

  if (tasks.length === 0) {
    lines.push('_No tasks documented yet._');
    return lines.join('\n');
  }

  for (const task of tasks) {
    const relativePath = `tasks/${task.id}.md`;
    const provider = isCursorDelegationMetadata(task.metadata)
      ? `${task.metadata.provider}:${task.metadata.providerStatus}`
      : 'none';
    lines.push(`- [${task.title}](${relativePath}) - ${task.status} - ${provider}`);
  }

  return lines.join('\n');
}

export function generateTaskDocumentation(
  db: OrchestratorDatabase,
  taskId: string,
  cwd: string = process.cwd()
): GeneratedTaskDocumentation | null {
  const task = db.getTask(taskId);
  if (!task) {
    return null;
  }

  const docsDir = path.resolve(cwd, DEFAULT_DOCS_DIR);
  const tasksDir = path.join(docsDir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const content = buildTaskDocumentation(db, task);
  const taskDocPath = path.join(tasksDir, `${task.id}.md`);
  fs.writeFileSync(taskDocPath, content, 'utf-8');

  const indexDocPath = path.join(docsDir, 'README.md');
  fs.writeFileSync(indexDocPath, buildDocsIndex(db), 'utf-8');

  return {
    taskDocPath,
    indexDocPath,
    content,
  };
}
