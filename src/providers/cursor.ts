import * as path from 'path';
import {
  CursorDelegationMetadata,
  CursorProviderMode,
  isCursorDelegationMetadata,
  TaskStatus,
} from '../models.js';
import { SpawnTaskInput, SpawnTaskResult, ResumeSessionInput, ResumeSessionResult, SyncTaskResult, AgentProvider, ProviderCheckResult } from './types.js';
import { loadOrchestratorConfig } from '../utils/orchestratorConfig.js';
import { commandExists, isProcessRunning, spawnDetachedCommand } from '../utils/subprocess.js';
import {
  buildCursorAgentArgs,
  buildCursorPrompt,
  buildResumeCommand,
  detectCursorFeatures,
  detectCursorVersion,
  getCursorArtifactsPaths,
  maybeCreateCursorChat,
  normalizeMode,
  readCursorLogSummary,
  readExitCode,
  shouldUseCursorWorktreeForTask,
} from '../utils/cursorCli.js';

export class CursorProvider implements AgentProvider {
  private readonly cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  async check(): Promise<ProviderCheckResult> {
    const config = loadOrchestratorConfig(this.cwd).cursor;
    const available = commandExists(config.binary, this.cwd);
    const version = available ? detectCursorVersion(config.binary, this.cwd) : null;
    const features = available ? detectCursorFeatures(config.binary, this.cwd) : [];
    const warnings = available
      ? []
      : [`Cursor CLI binary '${config.binary}' was not found in PATH.`];

    return {
      provider: 'cursor',
      available,
      binary: config.binary,
      version,
      runtime: config.runtime,
      features,
      warnings,
    };
  }

  async spawnTask(input: SpawnTaskInput): Promise<SpawnTaskResult> {
    const config = loadOrchestratorConfig(input.cwd).cursor;
    const normalized = normalizeMode(input.mode, input.cloud, config.defaultMode);
    const useWorktree = shouldUseCursorWorktreeForTask(input.task, config, input.useWorktree);
    const force = input.force ?? config.defaultForce;
    const warnings: string[] = [];
    const prompt = buildCursorPrompt({
      task: input.task,
      currentFocus: input.currentFocus,
      decisions: input.decisions,
      research: input.research,
    });

    let chatId: string | undefined;
    if (config.useCreateChat) {
      chatId = maybeCreateCursorChat(config.binary, input.cwd);
      if (!chatId) {
        warnings.push('Cursor CLI did not return a chat ID; resume will fall back to the latest session.');
      }
    }

    const { logPath, exitCodePath } = getCursorArtifactsPaths(config, input.cwd, input.task.id);
    const args = buildCursorAgentArgs({
      config,
      cwd: input.cwd,
      prompt,
      chatId,
      mode: normalized.mode,
      cloud: normalized.cloud,
      model: input.model ?? config.defaultModel,
      useWorktree,
      force,
    });

    const launched = spawnDetachedCommand({
      command: config.binary,
      args,
      cwd: input.cwd,
      logPath,
      exitCodePath,
    });

    const metadata: CursorDelegationMetadata = {
      provider: 'cursor',
      providerRuntime: config.runtime,
      providerStatus: 'running',
      providerSessionId: chatId,
      providerChatId: chatId,
      providerModel: input.model ?? config.defaultModel,
      providerMode: normalized.cloud ? 'cloud' : normalized.mode,
      providerPrompt: prompt,
      providerWorktree: useWorktree,
      providerTranscriptPath: logPath,
      providerLaunchCommand: launched.command,
      providerLaunchedAt: new Date().toISOString(),
      providerSpawnedBy: input.spawnedBy ?? undefined,
      providerPid: launched.pid,
      providerLogPath: logPath,
      providerExitCodePath: exitCodePath,
      providerLastSyncAt: new Date().toISOString(),
      providerWarnings: warnings,
    };

    return {
      metadata,
      command: launched.command,
      warnings,
    };
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult> {
    const config = loadOrchestratorConfig(input.cwd).cursor;
    const { command, args } = buildResumeCommand(config.binary, input.cwd, input.metadata);
    const warnings = input.metadata.providerChatId || input.metadata.providerSessionId
      ? []
      : ['No stored chat ID was found; the resume command will open Cursor’s latest session instead.'];

    return { command, args, warnings };
  }

  async syncTask(metadata: CursorDelegationMetadata): Promise<SyncTaskResult> {
    if (!isCursorDelegationMetadata(metadata)) {
      throw new Error('Task metadata does not belong to the Cursor provider.');
    }

    const exitCode = metadata.providerExitCodePath ? readExitCode(metadata.providerExitCodePath) : undefined;
    const running = isProcessRunning(metadata.providerPid);
    const outputSummary = metadata.providerLogPath ? readCursorLogSummary(metadata.providerLogPath) : undefined;

    if (running && exitCode === undefined) {
      return {
        metadata: {
          ...metadata,
          providerStatus: 'running',
          providerLastSyncAt: new Date().toISOString(),
        },
        outputSummary,
        finished: false,
      };
    }

    if (exitCode === undefined) {
      return {
        metadata: {
          ...metadata,
          providerStatus: metadata.providerStatus ?? 'spawned',
          providerLastSyncAt: new Date().toISOString(),
        },
        outputSummary,
        finished: false,
      };
    }

    return {
      metadata: {
        ...metadata,
        providerStatus: exitCode === 0 ? 'completed' : 'failed',
        providerLastSyncAt: new Date().toISOString(),
      },
      outputSummary,
      finished: true,
    };
  }
}

export function getCursorMetadata(taskMetadata: Record<string, unknown>): CursorDelegationMetadata | null {
  return isCursorDelegationMetadata(taskMetadata) ? taskMetadata : null;
}

export function getTaskStatusForDelegation(metadata: CursorDelegationMetadata): TaskStatus | null {
  if (metadata.providerStatus === 'completed') {
    return TaskStatus.COMPLETED;
  }

  if (metadata.providerStatus === 'failed') {
    return TaskStatus.FAILED;
  }

  return null;
}

export function getDelegationWorktreePath(metadata: CursorDelegationMetadata): string | undefined {
  if (!metadata.providerWorktree) {
    return undefined;
  }

  return metadata.providerWorktreePath ?? path.join('~', '.cursor', 'worktrees');
}
