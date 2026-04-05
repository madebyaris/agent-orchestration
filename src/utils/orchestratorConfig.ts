import * as fs from 'fs';
import * as path from 'path';
import {
  CursorProviderMode,
  DEFAULT_CURSOR_WORKTREE_COMPLEXITIES,
  ProviderRuntime,
  TaskComplexity,
} from '../models.js';

export interface CursorProviderConfig {
  binary: string;
  runtime: ProviderRuntime;
  defaultMode: Exclude<CursorProviderMode, 'cloud'>;
  defaultForce: boolean;
  autoApproveMcps: boolean;
  trustWorkspace: boolean;
  useCreateChat: boolean;
  logDir: string;
  defaultModel?: string;
  preferWorktreeFor: TaskComplexity[];
}

export interface OrchestratorConfig {
  cursor: CursorProviderConfig;
}

interface PartialConfigFile {
  cursor?: Partial<CursorProviderConfig>;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  cursor: {
    binary: process.env.CURSOR_AGENT_BINARY || 'agent',
    runtime: 'cli',
    defaultMode: 'agent',
    defaultForce: true,
    autoApproveMcps: true,
    trustWorkspace: true,
    useCreateChat: true,
    logDir: path.join('.agent-orchestration', 'providers', 'cursor'),
    preferWorktreeFor: DEFAULT_CURSOR_WORKTREE_COMPLEXITIES,
  },
};

export function loadOrchestratorConfig(cwd: string = process.cwd()): OrchestratorConfig {
  const configPath = path.join(cwd, 'agent-orchestration.config.json');
  if (!fs.existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as PartialConfigFile;
    return {
      cursor: {
        ...DEFAULT_CONFIG.cursor,
        ...parsed.cursor,
        preferWorktreeFor: parsed.cursor?.preferWorktreeFor ?? DEFAULT_CONFIG.cursor.preferWorktreeFor,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
