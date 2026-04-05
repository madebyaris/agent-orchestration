import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCursorAgentArgs, buildCursorPrompt, shouldUseCursorWorktreeForTask } from './cursorCli.js';
import { TaskComplexity, TaskPriority, TaskStatus } from '../models.js';
import { CursorProviderConfig } from './orchestratorConfig.js';
import { buildDelegationResumePrompt } from './delegationKnowledge.js';

const config: CursorProviderConfig = {
  binary: 'agent',
  runtime: 'cli',
  defaultMode: 'agent',
  defaultForce: true,
  autoApproveMcps: true,
  trustWorkspace: true,
  useCreateChat: true,
  logDir: '.agent-orchestration/providers/cursor',
  preferWorktreeFor: [TaskComplexity.MODERATE, TaskComplexity.COMPLEX],
  recoveryStaleAfterMs: 10 * 60 * 1000,
};

const baseTask = {
  id: 'task_123',
  title: 'Implement Cursor delegation',
  description: 'Launch delegated Cursor agents from orchestrator tasks.',
  status: TaskStatus.PENDING,
  priority: TaskPriority.HIGH,
  complexity: TaskComplexity.COMPLEX,
  researchReady: true,
  createdBy: null,
  assignedTo: null,
  dependencies: [],
  metadata: {},
  output: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  startedAt: null,
  completedAt: null,
};

test('uses worktrees for moderate and complex tasks by default', () => {
  assert.equal(shouldUseCursorWorktreeForTask(baseTask, config), true);
  assert.equal(
    shouldUseCursorWorktreeForTask({ ...baseTask, complexity: TaskComplexity.SIMPLE }, config),
    false
  );
});

test('builds a non-interactive Cursor agent command with approvals', () => {
  const args = buildCursorAgentArgs({
    config,
    cwd: '/tmp/project',
    prompt: 'Solve the task.',
    chatId: 'chat_123',
    mode: 'plan',
    cloud: false,
    model: 'gpt-5.2',
    useWorktree: true,
    force: true,
  });

  assert.deepEqual(args.slice(0, 6), ['--workspace', '/tmp/project', '--resume', 'chat_123', '--model', 'gpt-5.2']);
  assert.ok(args.includes('--mode'));
  assert.ok(args.includes('--worktree'));
  assert.ok(args.includes('--print'));
  assert.ok(args.includes('--force'));
  assert.ok(args.includes('--approve-mcps'));
  assert.ok(args.includes('--trust'));
  assert.equal(args.at(-1), 'Solve the task.');
});

test('builds a prompt that includes orchestration workflow instructions', () => {
  const prompt = buildCursorPrompt({
    task: baseTask,
    currentFocus: 'Make Cursor orchestration fully native.',
    decisions: [{ key: 'runtime', value: 'Cursor CLI first, ACP later.' }],
    research: {
      design: [{ key: 'provider', value: 'Use a CursorProvider abstraction.' }],
    },
  });

  assert.match(prompt, /Run the MCP tool `bootstrap` first\./);
  assert.match(prompt, /Use `lock_check` and `lock_acquire` before editing shared files\./);
  assert.match(prompt, /Current focus:/);
  assert.match(prompt, /Recent decisions:/);
  assert.match(prompt, /Documented research:/);
});

test('builds a resume prompt from live knowledge and shared context', () => {
  const prompt = buildDelegationResumePrompt({
    task: { ...baseTask, status: TaskStatus.IN_PROGRESS },
    currentFocus: 'Continue syncing delegated knowledge.',
    decisions: [
      {
        id: 'mem1',
        key: 'knowledge_loop',
        value: 'Write delegation updates back to shared memory.',
        namespace: 'decisions',
        createdBy: null,
        ttlSeconds: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: null,
      },
    ],
    research: {
      context: [
        {
          id: 'mem2',
          key: 'current_state',
          value: 'Cursor tasks currently sync only raw output.',
          namespace: 'research:task_123:context',
          createdBy: null,
          ttlSeconds: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: null,
        },
      ],
    },
    knowledge: {
      brief: [],
      updates: [],
      findings: [],
      decisions: [],
      handoff: [
        {
          id: 'mem3',
          key: 'latest_handoff',
          value: { summary: 'Resume from the last sync snapshot.' },
          namespace: 'delegation:task_123:handoff',
          createdBy: null,
          ttlSeconds: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: null,
        },
      ],
    },
  });

  assert.match(prompt, /Live orchestration context:/);
  assert.match(prompt, /Latest shared decisions:/);
  assert.match(prompt, /Research still relevant to this task:/);
  assert.match(prompt, /Latest handoff notes:/);
  assert.match(prompt, /Continue from the latest shared state rather than redoing prior work\./);
});
