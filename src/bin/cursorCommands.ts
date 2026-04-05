import { spawn } from 'child_process';
import { getDatabase } from '../database.js';
import { CursorProvider, getCursorMetadata } from '../providers/cursor.js';
import { TaskStatus } from '../models.js';
import {
  writeDelegationBrief,
  writeDelegationHandoff,
  writeDelegationSync,
} from '../utils/delegationKnowledge.js';
import { syncToActiveContext } from '../utils/contextSync.js';
import { getRecoveryDisplayLine } from '../utils/delegationRecovery.js';
import { generateTaskDocumentation } from '../utils/autoDocumentation.js';
import { getTaskDelegationContext, recoverDelegatedTask } from '../utils/delegatedTaskRuntime.js';

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    return undefined;
  }

  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function runDocCommand(args: string[]): void {
  const taskId = getFlagValue(args, '--task');
  if (!taskId) {
    throw new Error('Missing required flag: --task <taskId>');
  }

  const generated = generateTaskDocumentation(getDatabase(), taskId);
  if (!generated) {
    throw new Error(`Task ${taskId} not found.`);
  }

  console.log(`Task doc: ${generated.taskDocPath}`);
  console.log(`Index doc: ${generated.indexDocPath}`);
}

async function runCursorCheck(): Promise<void> {
  const result = await new CursorProvider(process.cwd()).check();
  console.log(`Cursor available: ${result.available ? 'yes' : 'no'}`);
  console.log(`Binary: ${result.binary}`);
  console.log(`Runtime: ${result.runtime}`);
  console.log(`Version: ${result.version ?? 'unknown'}`);
  console.log(`Features: ${result.features.join(', ') || 'none detected'}`);
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.log(`Warning: ${warning}`);
    }
  }

  if (!result.available) {
    process.exit(1);
  }
}

async function runCursorDelegate(args: string[]): Promise<void> {
  const taskId = getFlagValue(args, '--task');
  if (!taskId) {
    throw new Error('Missing required flag: --task <taskId>');
  }

  const db = getDatabase();
  const context = getTaskDelegationContext(db, taskId);
  if (!context) {
    throw new Error(`Task ${taskId} not found.`);
  }
  const { task, currentFocus, decisions, research } = context;

  const provider = new CursorProvider(process.cwd());
  const check = await provider.check();
  if (!check.available) {
    throw new Error(check.warnings.join('\n') || 'Cursor CLI is not available.');
  }

  const delegated = await provider.spawnTask({
    cwd: process.cwd(),
    task,
    currentFocus,
    decisions,
    research,
    mode: (getFlagValue(args, '--mode') as 'agent' | 'plan' | 'ask' | undefined) ?? undefined,
    model: getFlagValue(args, '--model'),
    cloud: hasFlag(args, '--cloud'),
    useWorktree: hasFlag(args, '--worktree') ? true : hasFlag(args, '--no-worktree') ? false : undefined,
    force: hasFlag(args, '--force') ? true : hasFlag(args, '--no-force') ? false : undefined,
  });

  const updated = db.updateTask(task.id, {
    status: TaskStatus.IN_PROGRESS,
    metadata: delegated.metadata,
  });
  if (updated) {
    writeDelegationBrief({
      db,
      task: updated,
      currentFocus,
      decisions,
      research,
      metadata: delegated.metadata,
    });
    generateTaskDocumentation(db, updated.id);
  }
  syncToActiveContext();

  console.log(`Delegated task '${task.title}' to Cursor.`);
  console.log(`Command: ${delegated.command}`);
  console.log(`Chat ID: ${delegated.metadata.providerChatId ?? 'unavailable'}`);
  console.log(`Run log: ${delegated.metadata.providerLogPath ?? 'unavailable'}`);

  if (delegated.warnings.length > 0) {
    for (const warning of delegated.warnings) {
      console.log(`Warning: ${warning}`);
    }
  }
}

async function runCursorResume(args: string[]): Promise<void> {
  const taskId = getFlagValue(args, '--task');
  if (!taskId) {
    throw new Error('Missing required flag: --task <taskId>');
  }

  const db = getDatabase();
  const context = getTaskDelegationContext(db, taskId);
  if (!context) {
    throw new Error(`Task ${taskId} not found.`);
  }
  const { task, currentFocus, decisions, research, knowledge } = context;

  const metadata = getCursorMetadata(task.metadata);
  if (!metadata) {
    throw new Error(`Task ${taskId} is not delegated to Cursor.`);
  }

  const provider = new CursorProvider(process.cwd());
  const result = await provider.resumeSession({
    cwd: process.cwd(),
    task,
    currentFocus,
    decisions,
    research,
    delegationKnowledge: knowledge,
    metadata,
  });

  console.log(`Resume command: ${result.command}`);
  if (result.prompt) {
    console.log('Resume prompt:');
    console.log(result.prompt);
  }
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      console.log(`Warning: ${warning}`);
    }
  }

  if (hasFlag(args, '--exec')) {
    const check = await provider.check();
    const child = spawn(check.binary, result.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  }
}

async function syncCliDelegatedTask(taskId: string) {
  const db = getDatabase();
  const task = db.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found.`);
  }

  const metadata = getCursorMetadata(task.metadata);
  if (!metadata) {
    throw new Error(`Task ${taskId} is not delegated to Cursor.`);
  }

  const provider = new CursorProvider(process.cwd());
  const result = await provider.syncTask(metadata);
  const updated = db.updateTask(task.id, {
    metadata: result.metadata,
    status: result.metadata.providerStatus === 'completed'
      ? TaskStatus.COMPLETED
      : result.metadata.providerStatus === 'failed'
        ? TaskStatus.FAILED
        : undefined,
    output: result.outputSummary ?? task.output ?? undefined,
  });

  if (updated) {
    writeDelegationSync({
      db,
      task: updated,
      metadata: result.metadata,
      outputSummary: result.outputSummary,
      finished: result.finished,
    });
    generateTaskDocumentation(db, updated.id);
  }
  syncToActiveContext();

  return { task, result };
}

async function runCursorStatus(args: string[]): Promise<void> {
  const taskId = getFlagValue(args, '--task');
  if (!taskId) {
    throw new Error('Missing required flag: --task <taskId>');
  }

  const { task, result } = await syncCliDelegatedTask(taskId);

  console.log(`Task: ${task.title}`);
  console.log(`Provider status: ${result.metadata.providerStatus}`);
  console.log(`Recovery: ${getRecoveryDisplayLine(result.metadata)}`);
  console.log(`Retry count: ${result.metadata.providerRetryCount ?? 0}`);
  if (result.reason) {
    console.log(`Reason: ${result.reason}`);
  }
  if (result.recoveryHints.length > 0) {
    for (const hint of result.recoveryHints) {
      console.log(`Hint: ${hint}`);
    }
  }
}

async function runCursorSync(args: string[]): Promise<void> {
  const taskId = getFlagValue(args, '--task');
  if (!taskId) {
    throw new Error('Missing required flag: --task <taskId>');
  }

  const { task, result } = await syncCliDelegatedTask(taskId);

  console.log(`Synced task '${task.title}'.`);
  console.log(`Provider status: ${result.metadata.providerStatus}`);
  console.log(`Recovery: ${getRecoveryDisplayLine(result.metadata)}`);
  if (result.reason) {
    console.log(`Reason: ${result.reason}`);
  }
  if (result.recoveryHints.length > 0) {
    for (const hint of result.recoveryHints) {
      console.log(`Hint: ${hint}`);
    }
  }
  if (result.outputSummary) {
    console.log(`Latest output: ${result.outputSummary}`);
  }
}

async function runCursorRecover(args: string[]): Promise<void> {
  const taskId = getFlagValue(args, '--task');
  if (!taskId) {
    throw new Error('Missing required flag: --task <taskId>');
  }

  const result = await recoverDelegatedTask({
    db: getDatabase(),
    taskId,
    cwd: process.cwd(),
    options: {
      mode: (getFlagValue(args, '--mode') as 'agent' | 'plan' | 'ask' | undefined) ?? undefined,
      model: getFlagValue(args, '--model'),
      cloud: hasFlag(args, '--cloud') ? true : undefined,
      useWorktree: hasFlag(args, '--worktree') ? true : hasFlag(args, '--no-worktree') ? false : undefined,
      force: hasFlag(args, '--force') ? true : undefined,
    },
  });

  if (!result) {
    throw new Error(`Task ${taskId} not found.`);
  }

  if (result.blocked) {
    throw new Error(result.reason ?? 'Recovery blocked.');
  }

  console.log(`Recovered task '${result.task.title}'.`);
  console.log(`Command: ${result.delegated.command}`);
  console.log(`Retry count: ${result.metadata.providerRetryCount ?? 0}`);
}

async function runCursorHandoff(args: string[]): Promise<void> {
  const taskId = getFlagValue(args, '--task');
  const summary = getFlagValue(args, '--summary');
  if (!taskId || !summary) {
    throw new Error('Missing required flags: --task <taskId> --summary "..."');
  }

  const db = getDatabase();
  const task = db.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found.`);
  }

  const metadata = getCursorMetadata(task.metadata);
  if (!metadata) {
    throw new Error(`Task ${taskId} is not delegated to Cursor.`);
  }

  const findings = getFlagValue(args, '--findings')?.split('||').map((value) => value.trim()).filter(Boolean) ?? [];
  const nextSteps = getFlagValue(args, '--next-steps')?.split('||').map((value) => value.trim()).filter(Boolean) ?? [];
  const blockers = getFlagValue(args, '--blockers')?.split('||').map((value) => value.trim()).filter(Boolean) ?? [];

  writeDelegationHandoff({
    db,
    taskId,
    summary,
    findings,
    nextSteps,
    blockers,
  });
  generateTaskDocumentation(db, task.id);
  syncToActiveContext();

  console.log(`Recorded handoff for '${task.title}'.`);
}

function runCursorList(): void {
  const db = getDatabase();
  const delegatedTasks = db.listTasks().filter((task) => getCursorMetadata(task.metadata));

  if (delegatedTasks.length === 0) {
    console.log('No Cursor delegations found.');
    return;
  }

  for (const task of delegatedTasks) {
    const metadata = getCursorMetadata(task.metadata);
    if (!metadata) {
      continue;
    }

    console.log(`${task.title} (${task.id})`);
    console.log(`  Status: ${metadata.providerStatus}`);
    console.log(`  Mode: ${metadata.providerMode ?? 'agent'}`);
    console.log(`  Chat ID: ${metadata.providerChatId ?? 'n/a'}`);
    console.log(`  Worktree: ${metadata.providerWorktree ? 'yes' : 'no'}`);
    console.log(`  Log: ${metadata.providerLogPath ?? 'n/a'}`);
  }
}

export async function runCursorCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'check':
      await runCursorCheck();
      return;
    case 'delegate':
      await runCursorDelegate(args.slice(1));
      return;
    case 'status':
      await runCursorStatus(args.slice(1));
      return;
    case 'resume':
      await runCursorResume(args.slice(1));
      return;
    case 'sync':
      await runCursorSync(args.slice(1));
      return;
    case 'recover':
      await runCursorRecover(args.slice(1));
      return;
    case 'handoff':
      await runCursorHandoff(args.slice(1));
      return;
    case 'list':
      runCursorList();
      return;
    default:
      throw new Error(`Unknown cursor subcommand: ${subcommand ?? '(none)'}`);
  }
}
