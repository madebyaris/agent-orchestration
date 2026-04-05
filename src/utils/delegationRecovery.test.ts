import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDelegationHealth } from './delegationRecovery.js';
import { CursorDelegationMetadata } from '../models.js';

const baseMetadata: CursorDelegationMetadata = {
  provider: 'cursor',
  providerRuntime: 'cli',
  providerStatus: 'running',
  providerChatId: 'chat_123',
  providerLaunchedAt: '2026-01-01T00:00:00.000Z',
  providerLastSyncAt: '2026-01-01T00:05:00.000Z',
};

test('marks non-zero exit codes as recoverable failures', () => {
  const result = evaluateDelegationHealth({
    metadata: baseMetadata,
    isRunning: false,
    exitCode: 1,
    staleAfterMs: 60_000,
  });

  assert.equal(result.state, 'failed');
  assert.equal(result.recoverable, true);
  assert.match(result.reason ?? '', /exited with code 1/);
});

test('marks missing process without exit code as stale after threshold', () => {
  const result = evaluateDelegationHealth({
    metadata: baseMetadata,
    isRunning: false,
    now: new Date('2026-01-01T00:20:00.000Z'),
    staleAfterMs: 5 * 60 * 1000,
  });

  assert.equal(result.state, 'stale');
  assert.equal(result.recoverable, true);
});

test('marks running delegations as healthy', () => {
  const result = evaluateDelegationHealth({
    metadata: baseMetadata,
    isRunning: true,
    staleAfterMs: 60_000,
  });

  assert.equal(result.state, 'healthy');
  assert.equal(result.recoverable, false);
});
