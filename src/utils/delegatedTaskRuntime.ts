import { OrchestratorDatabase } from '../database.js';
import { CursorDelegationMetadata, Task, TaskStatus } from '../models.js';
import { CursorProvider, getCursorMetadata, getTaskStatusForDelegation } from '../providers/cursor.js';
import { SpawnTaskResult } from '../providers/types.js';
import { generateTaskDocumentation } from './autoDocumentation.js';
import {
  listDelegationKnowledge,
  writeDelegationBrief,
  writeDelegationHandoff,
  writeDelegationSync,
} from './delegationKnowledge.js';
import { syncToActiveContext } from './contextSync.js';

export interface TaskDelegationContext {
  task: Task;
  currentFocus: string | null;
  decisions: ReturnType<OrchestratorDatabase['listMemory']>;
  research: ReturnType<OrchestratorDatabase['getTaskResearch']>;
  knowledge: ReturnType<typeof listDelegationKnowledge>;
}

export interface RecoverDelegatedTaskOptions {
  mode?: 'agent' | 'plan' | 'ask';
  model?: string;
  useWorktree?: boolean;
  cloud?: boolean;
  force?: boolean;
}

export type RecoverDelegatedTaskResult =
  | null
  | { blocked: true; task: Task; reason: string; metadata: CursorDelegationMetadata }
  | { blocked: false; task: Task; metadata: CursorDelegationMetadata; delegated: SpawnTaskResult };

export function getTaskDelegationContext(
  db: OrchestratorDatabase,
  taskId: string
): TaskDelegationContext | null {
  const task = db.getTask(taskId);
  if (!task) {
    return null;
  }

  const focus = db.getMemory('current_focus', 'context');
  return {
    task,
    currentFocus: focus ? String(focus.value) : null,
    decisions: db.listMemory('decisions'),
    research: db.getTaskResearch(task.id),
    knowledge: listDelegationKnowledge(db, task.id),
  };
}

export async function syncDelegatedTask(params: {
  db: OrchestratorDatabase;
  taskId: string;
  persistKnowledge?: boolean;
  createdBy?: string | null;
  cwd?: string;
}): Promise<Task | null> {
  const { db, taskId, persistKnowledge = true, createdBy, cwd } = params;
  const task = db.getTask(taskId);
  if (!task) {
    return null;
  }

  const metadata = getCursorMetadata(task.metadata);
  if (!metadata) {
    return task;
  }

  const provider = new CursorProvider(cwd ?? process.cwd());
  const result = await provider.syncTask(metadata);
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

  if (updated && persistKnowledge) {
    writeDelegationSync({
      db,
      task: updated,
      metadata: result.metadata,
      outputSummary: result.outputSummary,
      finished: result.finished,
      createdBy,
    });
    generateTaskDocumentation(db, updated.id, cwd);
  }

  syncToActiveContext();
  return updated;
}

export async function recoverDelegatedTask(params: {
  db: OrchestratorDatabase;
  taskId: string;
  options?: RecoverDelegatedTaskOptions;
  createdBy?: string | null;
  cwd?: string;
}): Promise<RecoverDelegatedTaskResult> {
  const { db, taskId, options, createdBy, cwd } = params;
  const syncedTask = await syncDelegatedTask({
    db,
    taskId,
    persistKnowledge: true,
    createdBy,
    cwd,
  });
  if (!syncedTask) {
    return null;
  }

  const metadata = getCursorMetadata(syncedTask.metadata);
  if (!metadata) {
    return null;
  }

  if (metadata.providerRecoveryState === 'healthy' && !options?.force) {
    return {
      task: syncedTask,
      blocked: true,
      reason: 'The delegated Cursor task still appears healthy. Use force to relaunch anyway.',
      metadata,
    };
  }

  const context = getTaskDelegationContext(db, taskId);
  if (!context) {
    return null;
  }

  const provider = new CursorProvider(cwd ?? process.cwd());
  const retryCount = (typeof metadata.providerRetryCount === 'number' ? metadata.providerRetryCount : 0) + 1;
  const delegated = await provider.spawnTask({
    cwd: cwd ?? process.cwd(),
    task: {
      ...context.task,
      metadata: {
        ...context.task.metadata,
        providerRetryCount: retryCount,
      },
    },
    currentFocus: context.currentFocus,
    decisions: context.decisions,
    research: context.research,
    mode: options?.mode ?? (metadata.providerMode && metadata.providerMode !== 'cloud' ? metadata.providerMode : undefined),
    model: options?.model ?? metadata.providerModel,
    useWorktree: options?.useWorktree ?? metadata.providerWorktree,
    cloud: options?.cloud ?? (metadata.providerMode === 'cloud'),
    force: options?.force,
    spawnedBy: createdBy,
  });

  const mergedMetadata: CursorDelegationMetadata = {
    ...delegated.metadata,
    providerRetryCount: retryCount,
    providerRecoveredAt: new Date().toISOString(),
    providerRecoveryState: 'healthy',
    providerRecoverable: false,
  };

  const updated = db.updateTask(context.task.id, {
    status: TaskStatus.IN_PROGRESS,
    metadata: mergedMetadata,
    output: context.task.output ?? undefined,
  });

  if (updated) {
    writeDelegationBrief({
      db,
      task: updated,
      currentFocus: context.currentFocus,
      decisions: context.decisions,
      research: context.research,
      metadata: mergedMetadata,
      createdBy,
    });
    writeDelegationHandoff({
      db,
      taskId: updated.id,
      summary: `Recovered delegated Cursor task after ${metadata.providerRecoveryState ?? 'unknown'} state.`,
      findings: metadata.providerLastError ? [metadata.providerLastError] : [],
      nextSteps: ['Resume or sync the new delegated run.', 'Verify the recovery succeeded.'],
      blockers: [],
      createdBy,
    });
    generateTaskDocumentation(db, updated.id, cwd);
  }

  syncToActiveContext();
  return {
    task: updated ?? context.task,
    blocked: false,
    metadata: mergedMetadata,
    delegated,
  };
}
