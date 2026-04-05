import { MemoryEntry, Task, CursorDelegationMetadata, CursorProviderMode, ProviderRuntime } from '../models.js';

export interface ProviderCheckResult {
  provider: 'cursor';
  available: boolean;
  binary: string;
  version: string | null;
  runtime: ProviderRuntime;
  features: string[];
  warnings: string[];
}

export interface SpawnTaskInput {
  cwd: string;
  task: Task;
  currentFocus: string | null;
  decisions: MemoryEntry[];
  research: Record<string, MemoryEntry[]>;
  mode?: Exclude<CursorProviderMode, 'cloud'>;
  cloud?: boolean;
  model?: string;
  useWorktree?: boolean;
  force?: boolean;
  spawnedBy?: string | null;
}

export interface SpawnTaskResult {
  metadata: CursorDelegationMetadata;
  command: string;
  warnings: string[];
}

export interface ResumeSessionInput {
  cwd: string;
  metadata: CursorDelegationMetadata;
  printOnly?: boolean;
}

export interface ResumeSessionResult {
  command: string;
  args: string[];
  warnings: string[];
}

export interface SyncTaskResult {
  metadata: CursorDelegationMetadata;
  outputSummary?: string;
  finished: boolean;
}

export interface AgentProvider {
  check(): Promise<ProviderCheckResult>;
  spawnTask(input: SpawnTaskInput): Promise<SpawnTaskResult>;
  resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult>;
  syncTask(metadata: CursorDelegationMetadata): Promise<SyncTaskResult>;
}
