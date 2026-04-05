import { CursorDelegationMetadata, ProviderRecoveryState } from '../models.js';

export interface DelegationHealth {
  state: ProviderRecoveryState;
  recoverable: boolean;
  reason?: string;
  hints: string[];
  exitCode?: number;
}

export function evaluateDelegationHealth(params: {
  metadata: CursorDelegationMetadata;
  isRunning: boolean;
  exitCode?: number;
  now?: Date;
  staleAfterMs: number;
}): DelegationHealth {
  const { metadata, isRunning, exitCode, staleAfterMs } = params;
  const now = params.now ?? new Date();

  if (exitCode !== undefined) {
    if (exitCode === 0) {
      return {
        state: 'completed',
        recoverable: false,
        exitCode,
        hints: ['Use `cursor_resume_task` to inspect the last session if needed.'],
      };
    }

    return {
      state: 'failed',
      recoverable: true,
      exitCode,
      reason: `Cursor run exited with code ${exitCode}.`,
      hints: [
        'Run `cursor_sync_task` to capture the latest output and recovery hints.',
        'Inspect the provider log for the failure details.',
        'Use `cursor_recover_task` to relaunch with the latest shared context.',
      ],
    };
  }

  if (isRunning) {
    return {
      state: 'healthy',
      recoverable: false,
      hints: ['The delegated process is still running. Use `cursor_sync_task` for a fresh snapshot.'],
    };
  }

  const referenceTime = metadata.providerLastSyncAt ?? metadata.providerLaunchedAt;
  if (referenceTime) {
    const ageMs = now.getTime() - new Date(referenceTime).getTime();
    if (ageMs >= staleAfterMs) {
      return {
        state: 'stale',
        recoverable: true,
        reason: `No running process or exit code was found after ${Math.round(ageMs / 1000)}s.`,
        hints: [
          'The delegated process appears stale or crashed without a clean exit.',
          'Use `cursor_recover_task` to relaunch with the latest shared knowledge.',
          'Record a `cursor_handoff_task` note if a human diagnosis is needed first.',
        ],
      };
    }
  }

  return {
    state: 'unknown',
    recoverable: true,
    reason: 'The delegated process is not running and no exit code was captured yet.',
    hints: [
      'Run `cursor_sync_task` again after a short wait.',
      'Use `cursor_recover_task` if the process does not come back.',
    ],
  };
}

export function getRecoveryDisplayLine(metadata: CursorDelegationMetadata): string {
  const state = metadata.providerRecoveryState ?? 'unknown';
  const recoverable = metadata.providerRecoverable ? 'recoverable' : 'stable';
  return `${state} (${recoverable})`;
}
