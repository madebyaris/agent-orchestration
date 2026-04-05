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
import { buildDelegationResumePrompt } from '../utils/delegationKnowledge.js';
import { evaluateDelegationHealth } from '../utils/delegationRecovery.js';

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
    const delegatedAgentName = `cursor-sub-${input.task.id.slice(0, 8)}-${Date.now()}`;
    const prompt = buildCursorPrompt({
      task: input.task,
      currentFocus: input.currentFocus,
      decisions: input.decisions,
      research: input.research,
      delegatedAgentName,
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
      env: {
        MCP_ORCH_AGENT_NAME: delegatedAgentName,
        MCP_ORCH_AGENT_ROLE: 'sub',
        MCP_ORCH_CAPABILITIES: 'code',
      },
    });

    const metadata: CursorDelegationMetadata = {
      provider: 'cursor',
      providerRuntime: config.runtime,
      providerStatus: 'running',
      providerSessionId: chatId,
      providerChatId: chatId,
      providerAgentName: delegatedAgentName,
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
      providerRecoveryState: 'healthy',
      providerRecoverable: false,
      providerRetryCount: input.task.metadata.providerRetryCount as number | undefined,
    };

    return {
      metadata,
      command: launched.command,
      warnings,
    };
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult> {
    const config = loadOrchestratorConfig(input.cwd).cursor;
    const prompt = buildDelegationResumePrompt({
      task: input.task,
      currentFocus: input.currentFocus,
      decisions: input.decisions,
      research: input.research,
      knowledge: input.delegationKnowledge,
    });
    const { command, args } = buildResumeCommand(config.binary, input.cwd, input.metadata, prompt);
    const warnings = input.metadata.providerChatId || input.metadata.providerSessionId
      ? []
      : ['No stored chat ID was found; the resume command will open Cursor’s latest session instead.'];

    return { command, args, warnings, prompt };
  }

  async syncTask(metadata: CursorDelegationMetadata): Promise<SyncTaskResult> {
    if (!isCursorDelegationMetadata(metadata)) {
      throw new Error('Task metadata does not belong to the Cursor provider.');
    }

    const exitCode = metadata.providerExitCodePath ? readExitCode(metadata.providerExitCodePath) : undefined;
    const running = isProcessRunning(metadata.providerPid);
    const outputSummary = metadata.providerLogPath ? readCursorLogSummary(metadata.providerLogPath) : undefined;
    const config = loadOrchestratorConfig(this.cwd).cursor;
    const health = evaluateDelegationHealth({
      metadata,
      isRunning: running,
      exitCode,
      staleAfterMs: config.recoveryStaleAfterMs,
    });

    if (health.state === 'healthy') {
      return {
        metadata: {
          ...metadata,
          providerStatus: 'running',
          providerLastSyncAt: new Date().toISOString(),
          providerRecoveryState: health.state,
          providerRecoverable: health.recoverable,
          providerRecoveryHints: health.hints,
        },
        outputSummary,
        finished: false,
        recoveryState: health.state,
        recoverable: health.recoverable,
        recoveryHints: health.hints,
        reason: health.reason,
      };
    }

    if (health.state === 'unknown' || health.state === 'stale') {
      return {
        metadata: {
          ...metadata,
          providerStatus: health.state === 'stale' ? 'failed' : metadata.providerStatus ?? 'spawned',
          providerLastSyncAt: new Date().toISOString(),
          providerRecoveryState: health.state,
          providerRecoverable: health.recoverable,
          providerRecoveryHints: health.hints,
          providerLastError: health.reason,
          providerLastExitCode: health.exitCode,
        },
        outputSummary,
        finished: false,
        recoveryState: health.state,
        recoverable: health.recoverable,
        recoveryHints: health.hints,
        reason: health.reason,
      };
    }

    return {
      metadata: {
        ...metadata,
        providerStatus: exitCode === 0 ? 'completed' : 'failed',
        providerLastSyncAt: new Date().toISOString(),
        providerRecoveryState: health.state,
        providerRecoverable: health.recoverable,
        providerRecoveryHints: health.hints,
        providerLastError: health.reason,
        providerLastExitCode: health.exitCode,
      },
      outputSummary,
      finished: true,
      recoveryState: health.state,
      recoverable: health.recoverable,
      recoveryHints: health.hints,
      reason: health.reason,
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
