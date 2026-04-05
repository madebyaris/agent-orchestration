import { OrchestratorDatabase } from '../database.js';
import { CursorDelegationMetadata, MemoryEntry, Task } from '../models.js';

export type DelegationKnowledgeCategory = 'brief' | 'updates' | 'findings' | 'decisions' | 'handoff';

export interface DelegationKnowledgeBundle {
  brief: MemoryEntry[];
  updates: MemoryEntry[];
  findings: MemoryEntry[];
  decisions: MemoryEntry[];
  handoff: MemoryEntry[];
}

export function getDelegationNamespace(taskId: string, category: DelegationKnowledgeCategory): string {
  return `delegation:${taskId}:${category}`;
}

export function listDelegationKnowledge(db: OrchestratorDatabase, taskId: string): DelegationKnowledgeBundle {
  return {
    brief: db.listMemory(getDelegationNamespace(taskId, 'brief')),
    updates: db.listMemory(getDelegationNamespace(taskId, 'updates')),
    findings: db.listMemory(getDelegationNamespace(taskId, 'findings')),
    decisions: db.listMemory(getDelegationNamespace(taskId, 'decisions')),
    handoff: db.listMemory(getDelegationNamespace(taskId, 'handoff')),
  };
}

export function serializeMemoryEntries(entries: MemoryEntry[]): Array<{ key: string; value: unknown; updatedAt: string }> {
  return entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    updatedAt: entry.updatedAt.toISOString(),
  }));
}

export function writeDelegationBrief(params: {
  db: OrchestratorDatabase;
  task: Task;
  currentFocus: string | null;
  decisions: MemoryEntry[];
  research: Record<string, MemoryEntry[]>;
  metadata: CursorDelegationMetadata;
  createdBy?: string | null;
}): void {
  const { db, task, currentFocus, decisions, research, metadata, createdBy } = params;

  db.setMemory({
    namespace: getDelegationNamespace(task.id, 'brief'),
    key: 'task_brief',
    value: {
      taskId: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      complexity: task.complexity,
      dependencies: task.dependencies,
      currentFocus,
      provider: {
        status: metadata.providerStatus,
        mode: metadata.providerMode,
        chatId: metadata.providerChatId,
        worktree: metadata.providerWorktree,
        launchedAt: metadata.providerLaunchedAt,
      },
      researchCategories: Object.keys(research),
    },
    createdBy,
  });

  if (decisions.length > 0) {
    db.setMemory({
      namespace: getDelegationNamespace(task.id, 'decisions'),
      key: 'decision_snapshot',
      value: serializeMemoryEntries(decisions),
      createdBy,
    });
  }

  db.setMemory({
    namespace: getDelegationNamespace(task.id, 'handoff'),
    key: 'initial_handoff',
    value: {
      summary: `Delegated task '${task.title}' to Cursor.`,
      nextSteps: [
        'Resume the delegated agent as needed.',
        'Use cursor_sync_task to refresh shared knowledge.',
        'Use cursor_handoff_task to record a human or agent handoff.',
      ],
      updatedAt: new Date().toISOString(),
    },
    createdBy,
  });
}

export function writeDelegationSync(params: {
  db: OrchestratorDatabase;
  task: Task;
  metadata: CursorDelegationMetadata;
  outputSummary?: string;
  finished: boolean;
  createdBy?: string | null;
}): void {
  const { db, task, metadata, outputSummary, finished, createdBy } = params;
  const updatedAt = new Date().toISOString();

  db.setMemory({
    namespace: getDelegationNamespace(task.id, 'updates'),
    key: 'last_sync',
    value: {
      status: metadata.providerStatus,
      recoveryState: metadata.providerRecoveryState,
      recoverable: metadata.providerRecoverable,
      mode: metadata.providerMode,
      chatId: metadata.providerChatId,
      lastSyncAt: updatedAt,
      finished,
      lastError: metadata.providerLastError,
    },
    createdBy,
  });

  if (outputSummary) {
    db.setMemory({
      namespace: getDelegationNamespace(task.id, 'findings'),
      key: 'latest_output',
      value: {
        summary: outputSummary,
        status: metadata.providerStatus,
        recoveryState: metadata.providerRecoveryState,
        updatedAt,
      },
      createdBy,
    });
  }

  if (finished) {
    db.setMemory({
      namespace: getDelegationNamespace(task.id, 'handoff'),
      key: 'latest_handoff',
      value: {
        summary: outputSummary ?? `Task '${task.title}' finished with status ${metadata.providerStatus}.`,
        status: metadata.providerStatus,
        recoveryState: metadata.providerRecoveryState,
        updatedAt,
      },
      createdBy,
    });
  }
}

export function writeDelegationHandoff(params: {
  db: OrchestratorDatabase;
  taskId: string;
  summary: string;
  findings?: string[];
  nextSteps?: string[];
  blockers?: string[];
  createdBy?: string | null;
}): void {
  const { db, taskId, summary, findings, nextSteps, blockers, createdBy } = params;
  const updatedAt = new Date().toISOString();

  db.setMemory({
    namespace: getDelegationNamespace(taskId, 'handoff'),
    key: 'manual_handoff',
    value: {
      summary,
      findings: findings ?? [],
      nextSteps: nextSteps ?? [],
      blockers: blockers ?? [],
      updatedAt,
    },
    createdBy,
  });

  if (findings && findings.length > 0) {
    db.setMemory({
      namespace: getDelegationNamespace(taskId, 'findings'),
      key: 'manual_findings',
      value: findings,
      createdBy,
    });
  }
}

function formatEntryValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

export function buildDelegationResumePrompt(params: {
  task: Task;
  currentFocus: string | null;
  decisions: MemoryEntry[];
  research: Record<string, MemoryEntry[]>;
  knowledge: DelegationKnowledgeBundle;
}): string {
  const { task, currentFocus, decisions, research, knowledge } = params;
  const lines: string[] = [
    `Resume work on orchestrated task '${task.title}'.`,
    '',
    'Live orchestration context:',
    `- Task ID: ${task.id}`,
    `- Status: ${task.status}`,
    `- Priority: ${task.priority}`,
    `- Complexity: ${task.complexity}`,
    `- Current focus: ${currentFocus ?? 'Not set.'}`,
  ];

  if (decisions.length > 0) {
    lines.push('', 'Latest shared decisions:');
    for (const entry of decisions.slice(0, 8)) {
      lines.push(`- ${entry.key}: ${formatEntryValue(entry.value)}`);
    }
  }

  const researchCategories = Object.keys(research);
  if (researchCategories.length > 0) {
    lines.push('', 'Research still relevant to this task:');
    for (const category of researchCategories) {
      lines.push(`- ${category}:`);
      for (const entry of research[category].slice(0, 8)) {
        lines.push(`  - ${entry.key}: ${formatEntryValue(entry.value)}`);
      }
    }
  }

  if (knowledge.brief.length > 0) {
    lines.push('', 'Original delegation brief:');
    for (const entry of knowledge.brief.slice(0, 3)) {
      lines.push(`- ${entry.key}: ${formatEntryValue(entry.value)}`);
    }
  }

  if (knowledge.updates.length > 0) {
    lines.push('', 'Recent delegation updates:');
    for (const entry of knowledge.updates.slice(0, 3)) {
      lines.push(`- ${entry.key}: ${formatEntryValue(entry.value)}`);
    }
  }

  if (knowledge.findings.length > 0) {
    lines.push('', 'Known findings from prior runs:');
    for (const entry of knowledge.findings.slice(0, 3)) {
      lines.push(`- ${entry.key}: ${formatEntryValue(entry.value)}`);
    }
  }

  if (knowledge.handoff.length > 0) {
    lines.push('', 'Latest handoff notes:');
    for (const entry of knowledge.handoff.slice(0, 3)) {
      lines.push(`- ${entry.key}: ${formatEntryValue(entry.value)}`);
    }
  }

  lines.push(
    '',
    'Continue from the latest shared state rather than redoing prior work.',
    'Before editing, re-check locks and preserve the orchestration workflow.',
    'When done, write a concise summary and complete the task.'
  );

  return lines.join('\n');
}
