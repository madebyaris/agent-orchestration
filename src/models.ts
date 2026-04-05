/**
 * Type definitions for MCP Memory Orchestrator
 */

import { ulid } from 'ulid';

// ==================== Enums ====================

export enum AgentRole {
  MAIN = 'main',
  SUB = 'sub',
}

export enum AgentStatus {
  ACTIVE = 'active',
  IDLE = 'idle',
  BUSY = 'busy',
  OFFLINE = 'offline',
}

export enum TaskStatus {
  PENDING = 'pending',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum TaskPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

export enum TaskComplexity {
  TRIVIAL = 'trivial',
  SIMPLE = 'simple',
  MODERATE = 'moderate',
  COMPLEX = 'complex',
}

export type ProviderName = 'cursor';
export type ProviderRuntime = 'cli' | 'acp';
export type CursorProviderMode = 'agent' | 'plan' | 'ask' | 'cloud';
export type ProviderExecutionStatus = 'spawned' | 'running' | 'completed' | 'failed';

export enum EventType {
  AGENT_REGISTERED = 'agent_registered',
  AGENT_UNREGISTERED = 'agent_unregistered',
  AGENT_HEARTBEAT = 'agent_heartbeat',
  TASK_CREATED = 'task_created',
  TASK_ASSIGNED = 'task_assigned',
  TASK_CLAIMED = 'task_claimed',
  TASK_UPDATED = 'task_updated',
  TASK_COMPLETED = 'task_completed',
  MEMORY_SET = 'memory_set',
  MEMORY_DELETE = 'memory_delete',
  LOCK_ACQUIRED = 'lock_acquired',
  LOCK_RELEASED = 'lock_released',
}

// ==================== Core Types ====================

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  capabilities: string[];
  metadata: Record<string, unknown>;
  registeredAt: Date;
  lastHeartbeat: Date;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  complexity: TaskComplexity;
  researchReady: boolean;
  createdBy: string | null;
  assignedTo: string | null;
  dependencies: string[];
  metadata: Record<string, unknown>;
  output: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface MemoryEntry {
  id: string;
  key: string;
  value: unknown;
  namespace: string;
  createdBy: string | null;
  ttlSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

export interface Lock {
  id: string;
  resource: string;
  heldBy: string;
  acquiredAt: Date;
  expiresAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface Event {
  id: string;
  eventType: EventType;
  agentId: string | null;
  resourceId: string | null;
  details: Record<string, unknown>;
  timestamp: Date;
}

export interface CursorDelegationMetadata extends Record<string, unknown> {
  provider: ProviderName;
  providerRuntime: ProviderRuntime;
  providerStatus: ProviderExecutionStatus;
  providerSessionId?: string;
  providerChatId?: string;
  providerAgentId?: string;
  providerModel?: string;
  providerMode?: CursorProviderMode;
  providerPrompt?: string;
  providerWorktree?: boolean;
  providerWorktreePath?: string;
  providerTranscriptPath?: string;
  providerLaunchCommand?: string;
  providerLaunchedAt?: string;
  providerSpawnedBy?: string;
  providerPid?: number;
  providerLogPath?: string;
  providerExitCodePath?: string;
  providerLastSyncAt?: string;
  providerWarnings?: string[];
}

// ==================== Factory Functions ====================

export function createAgent(params: {
  name: string;
  role?: AgentRole;
  capabilities?: string[];
  status?: AgentStatus;
  metadata?: Record<string, unknown>;
}): Agent {
  const now = new Date();
  return {
    id: ulid(),
    name: params.name,
    role: params.role ?? AgentRole.SUB,
    status: params.status ?? AgentStatus.IDLE,
    capabilities: params.capabilities ?? [],
    metadata: params.metadata ?? {},
    registeredAt: now,
    lastHeartbeat: now,
  };
}

/**
 * Keywords used to auto-detect task complexity
 */
export const COMPLEXITY_KEYWORDS: Record<TaskComplexity, string[]> = {
  [TaskComplexity.TRIVIAL]: ['typo', 'comment', 'rename', 'config', 'formatting', 'whitespace'],
  [TaskComplexity.SIMPLE]: ['fix', 'bug', 'update', 'change', 'refactor', 'tweak', 'adjust'],
  [TaskComplexity.MODERATE]: ['add', 'create', 'implement', 'endpoint', 'component', 'test', 'api'],
  [TaskComplexity.COMPLEX]: ['feature', 'migrate', 'architecture', 'redesign', 'integrate', 'new system', 'overhaul', 'rebuild'],
};

/**
 * Research requirements for each complexity level
 */
export const RESEARCH_REQUIREMENTS: Record<TaskComplexity, string[]> = {
  [TaskComplexity.TRIVIAL]: [], // No research needed
  [TaskComplexity.SIMPLE]: ['context', 'files'],
  [TaskComplexity.MODERATE]: ['context', 'files', 'requirements'],
  [TaskComplexity.COMPLEX]: ['context', 'files', 'requirements', 'design'],
};

export const DEFAULT_CURSOR_WORKTREE_COMPLEXITIES: TaskComplexity[] = [
  TaskComplexity.MODERATE,
  TaskComplexity.COMPLEX,
];

/**
 * Detect task complexity from title/description keywords
 */
export function detectComplexity(title: string, description?: string): TaskComplexity {
  const text = `${title} ${description ?? ''}`.toLowerCase();
  
  // Check from most complex to least complex
  for (const keyword of COMPLEXITY_KEYWORDS[TaskComplexity.COMPLEX]) {
    if (text.includes(keyword)) return TaskComplexity.COMPLEX;
  }
  for (const keyword of COMPLEXITY_KEYWORDS[TaskComplexity.MODERATE]) {
    if (text.includes(keyword)) return TaskComplexity.MODERATE;
  }
  for (const keyword of COMPLEXITY_KEYWORDS[TaskComplexity.SIMPLE]) {
    if (text.includes(keyword)) return TaskComplexity.SIMPLE;
  }
  for (const keyword of COMPLEXITY_KEYWORDS[TaskComplexity.TRIVIAL]) {
    if (text.includes(keyword)) return TaskComplexity.TRIVIAL;
  }
  
  // Default to simple if no keywords match
  return TaskComplexity.SIMPLE;
}

export function shouldUseCursorWorktree(
  complexity: TaskComplexity,
  preferredComplexities: TaskComplexity[] = DEFAULT_CURSOR_WORKTREE_COMPLEXITIES
): boolean {
  return preferredComplexities.includes(complexity);
}

export function isCursorDelegationMetadata(value: unknown): value is CursorDelegationMetadata {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return candidate.provider === 'cursor' && typeof candidate.providerStatus === 'string';
}

export function createTask(params: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  complexity?: TaskComplexity;
  researchReady?: boolean;
  createdBy?: string | null;
  assignedTo?: string | null;
  dependencies?: string[];
  metadata?: Record<string, unknown>;
  status?: TaskStatus;
  startedAt?: Date | null;
}): Task {
  const now = new Date();
  const complexity = params.complexity ?? detectComplexity(params.title, params.description);
  // Trivial tasks are automatically research-ready
  const researchReady = params.researchReady ?? (complexity === TaskComplexity.TRIVIAL);
  
  return {
    id: ulid(),
    title: params.title,
    description: params.description ?? '',
    status: params.status ?? TaskStatus.PENDING,
    priority: params.priority ?? TaskPriority.NORMAL,
    complexity,
    researchReady,
    createdBy: params.createdBy ?? null,
    assignedTo: params.assignedTo ?? null,
    dependencies: params.dependencies ?? [],
    metadata: params.metadata ?? {},
    output: null,
    createdAt: now,
    updatedAt: now,
    startedAt: params.startedAt ?? null,
    completedAt: null,
  };
}

export function createMemoryEntry(params: {
  key: string;
  value: unknown;
  namespace?: string;
  createdBy?: string | null;
  ttlSeconds?: number | null;
}): MemoryEntry {
  const now = new Date();
  let expiresAt: Date | null = null;

  if (params.ttlSeconds) {
    expiresAt = new Date(now.getTime() + params.ttlSeconds * 1000);
  }

  return {
    id: ulid(),
    key: params.key,
    value: params.value,
    namespace: params.namespace ?? 'default',
    createdBy: params.createdBy ?? null,
    ttlSeconds: params.ttlSeconds ?? null,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  };
}

export function createLock(params: {
  resource: string;
  heldBy: string;
  timeoutSeconds?: number;
  metadata?: Record<string, unknown>;
}): Lock {
  const now = new Date();
  const expiresAt = params.timeoutSeconds
    ? new Date(now.getTime() + params.timeoutSeconds * 1000)
    : null;

  return {
    id: ulid(),
    resource: params.resource,
    heldBy: params.heldBy,
    acquiredAt: now,
    expiresAt,
    metadata: params.metadata ?? {},
  };
}

export function createEvent(params: {
  eventType: EventType;
  agentId?: string | null;
  resourceId?: string | null;
  details?: Record<string, unknown>;
}): Event {
  return {
    id: ulid(),
    eventType: params.eventType,
    agentId: params.agentId ?? null,
    resourceId: params.resourceId ?? null,
    details: params.details ?? {},
    timestamp: new Date(),
  };
}
