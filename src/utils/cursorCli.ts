import * as fs from 'fs';
import * as path from 'path';
import {
  CursorDelegationMetadata,
  CursorProviderMode,
  Task,
  TaskComplexity,
  shouldUseCursorWorktree,
} from '../models.js';
import { CursorProviderConfig } from './orchestratorConfig.js';
import { formatCommand, runCommand } from './subprocess.js';

export function detectCursorVersion(binary: string, cwd: string): string | null {
  const probes = [
    runCommand(binary, ['--version'], { cwd }),
    runCommand(binary, ['-v'], { cwd }),
  ];

  for (const probe of probes) {
    const version = `${probe.stdout}\n${probe.stderr}`.trim();
    if (probe.success && version) {
      return version.split('\n')[0]?.trim() ?? null;
    }
  }

  return null;
}

export function detectCursorFeatures(binary: string, cwd: string): string[] {
  const help = runCommand(binary, ['--help'], { cwd });
  const output = `${help.stdout}\n${help.stderr}`;
  const features: string[] = [];

  const knownFeatures = [
    ['--worktree', 'worktree'],
    ['create-chat', 'create-chat'],
    ['resume', 'resume'],
    ['mcp', 'mcp'],
    ['acp', 'acp'],
    ['--cloud', 'cloud'],
    ['--mode', 'modes'],
  ] as const;

  for (const [needle, feature] of knownFeatures) {
    if (output.includes(needle)) {
      features.push(feature);
    }
  }

  return features;
}

export function getCursorArtifactsPaths(
  config: CursorProviderConfig,
  cwd: string,
  taskId: string
): { logPath: string; exitCodePath: string } {
  const baseDir = path.resolve(cwd, config.logDir);
  return {
    logPath: path.join(baseDir, `${taskId}.log`),
    exitCodePath: path.join(baseDir, `${taskId}.exit`),
  };
}

export function shouldUseCursorWorktreeForTask(
  task: Task,
  config: CursorProviderConfig,
  requested?: boolean
): boolean {
  if (requested !== undefined) {
    return requested;
  }

  return shouldUseCursorWorktree(task.complexity, config.preferWorktreeFor);
}

export function buildCursorPrompt(input: {
  task: Task;
  currentFocus: string | null;
  decisions: Array<{ key: string; value: unknown }>;
  research: Record<string, Array<{ key: string; value: unknown }>>;
  delegatedAgentName?: string;
}): string {
  const lines: string[] = [
    `You are working on this orchestrated task: ${input.task.title}`,
    '',
    'Task details:',
    `- Task ID: ${input.task.id}`,
    `- Title: ${input.task.title}`,
    `- Description: ${input.task.description || 'No description provided.'}`,
    `- Complexity: ${input.task.complexity}`,
    `- Priority: ${input.task.priority}`,
  ];

  if (input.task.dependencies.length > 0) {
    lines.push(`- Dependencies: ${input.task.dependencies.join(', ')}`);
  }

  lines.push('', 'Current focus:');
  lines.push(input.currentFocus ?? 'Not set.');

  if (input.decisions.length > 0) {
    lines.push('', 'Recent decisions:');
    for (const decision of input.decisions.slice(0, 10)) {
      const value = typeof decision.value === 'string'
        ? decision.value
        : JSON.stringify(decision.value);
      lines.push(`- ${decision.key}: ${value}`);
    }
  }

  const researchCategories = Object.keys(input.research);
  if (researchCategories.length > 0) {
    lines.push('', 'Documented research:');
    for (const category of researchCategories) {
      lines.push(`- ${category}:`);
      for (const entry of input.research[category].slice(0, 10)) {
        const value = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
        lines.push(`  - ${entry.key}: ${value}`);
      }
    }
  }

  lines.push(
    '',
    'Workflow requirements:',
    '- You are a delegated sub-agent, not the main agent.',
    `- Start by running \`claim_todo\` with the exact task title "${input.task.title}".`,
    '- If you need to bootstrap manually, register as a sub-agent, never as the main agent.',
    input.delegatedAgentName
      ? `- Your expected sub-agent name is \`${input.delegatedAgentName}\`.`
      : '- Use a unique sub-agent identity for this delegated run.',
    '- Use `lock_check` and `lock_acquire` before editing shared files.',
    '- Record important findings in shared memory when helpful.',
    '- Use `task_complete` when done and `agent_unregister` before finishing your session.',
    '',
    'Goal:',
    'Complete the task end-to-end with the existing orchestration workflow.'
  );

  return lines.join('\n');
}

export function buildCursorAgentArgs(input: {
  config: CursorProviderConfig;
  cwd: string;
  prompt: string;
  chatId?: string;
  mode?: Exclude<CursorProviderMode, 'cloud'>;
  cloud?: boolean;
  model?: string;
  useWorktree: boolean;
  force: boolean;
}): string[] {
  const args: string[] = ['--workspace', input.cwd];

  if (input.chatId) {
    args.push('--resume', input.chatId);
  }

  if (input.model) {
    args.push('--model', input.model);
  }

  if (input.cloud) {
    args.push('--cloud');
  } else if (input.mode && input.mode !== 'agent') {
    args.push('--mode', input.mode);
  }

  if (input.useWorktree) {
    args.push('--worktree');
  }

  args.push('--print', '--output-format', 'text');

  if (input.force) {
    args.push('--force');
  }

  if (input.config.autoApproveMcps) {
    args.push('--approve-mcps');
  }

  if (input.config.trustWorkspace) {
    args.push('--trust');
  }

  args.push(input.prompt);

  return args;
}

export function buildResumeCommand(
  binary: string,
  cwd: string,
  metadata: CursorDelegationMetadata,
  prompt?: string
): { args: string[]; command: string } {
  const args = ['--workspace', cwd];
  const sessionId = metadata.providerChatId ?? metadata.providerSessionId;

  if (sessionId) {
    args.push('--resume', sessionId);
  } else {
    args.push('resume');
  }

  if (prompt) {
    args.push(prompt);
  }

  const command = formatCommand(binary, args);
  return { args, command };
}

export function maybeCreateCursorChat(binary: string, cwd: string): string | undefined {
  const result = runCommand(binary, ['--workspace', cwd, 'create-chat'], { cwd });
  if (!result.success) {
    return undefined;
  }

  const output = `${result.stdout}\n${result.stderr}`.trim();
  const match = output.match(/[A-Za-z0-9_-]{6,}/);
  return match?.[0];
}

export function readCursorLogSummary(logPath: string, maxChars: number = 4000): string | undefined {
  if (!fs.existsSync(logPath)) {
    return undefined;
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  return content.slice(-maxChars).trim() || undefined;
}

export function readExitCode(exitCodePath: string): number | undefined {
  if (!fs.existsSync(exitCodePath)) {
    return undefined;
  }

  const raw = fs.readFileSync(exitCodePath, 'utf-8').trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getDelegationDisplayStatus(metadata: CursorDelegationMetadata): string {
  const mode = metadata.providerMode ?? 'agent';
  const worktreeLabel = metadata.providerWorktree ? 'worktree' : 'workspace';
  return `${metadata.providerStatus} via ${mode} (${worktreeLabel})`;
}

export function normalizeMode(
  requestedMode: Exclude<CursorProviderMode, 'cloud'> | undefined,
  requestedCloud: boolean | undefined,
  configMode: Exclude<CursorProviderMode, 'cloud'>
): { mode: Exclude<CursorProviderMode, 'cloud'>; cloud: boolean } {
  if (requestedCloud) {
    return { mode: 'agent', cloud: true };
  }

  return {
    mode: requestedMode ?? configMode,
    cloud: false,
  };
}

export function complexityLabel(complexity: TaskComplexity): string {
  return complexity.charAt(0).toUpperCase() + complexity.slice(1);
}
