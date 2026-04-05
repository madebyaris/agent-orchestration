/**
 * SQLite database operations for MCP Orchestrator
 * Uses better-sqlite3 for synchronous, high-performance SQLite access
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import {
  Agent,
  AgentRole,
  AgentStatus,
  createAgent,
  createEvent,
  createLock,
  createMemoryEntry,
  createTask,
  Event,
  EventType,
  Lock,
  MemoryEntry,
  Task,
  TaskComplexity,
  TaskPriority,
  TaskStatus,
  RESEARCH_REQUIREMENTS,
} from './models.js';

// Default database path relative to project root
const DEFAULT_DB_DIR = '.agent-orchestration';
const DEFAULT_DB_NAME = 'orchestrator.db';

// Heartbeat TTL - agents without heartbeat for this long are marked offline
const HEARTBEAT_TTL_SECONDS = 300; // 5 minutes

/**
 * Get the database path from environment or use default
 */
function getDbPath(): string {
  const dbPath = process.env.MCP_ORCH_DB_PATH;
  if (dbPath) {
    // If relative path, resolve from cwd
    if (!path.isAbsolute(dbPath)) {
      return path.resolve(process.cwd(), dbPath);
    }
    return dbPath;
  }

  // Use current working directory as project root
  return path.join(process.cwd(), DEFAULT_DB_DIR, DEFAULT_DB_NAME);
}

const SCHEMA = `
-- Agents table
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'sub',
    status TEXT NOT NULL DEFAULT 'idle',
    capabilities TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    registered_at TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'normal',
    complexity TEXT NOT NULL DEFAULT 'simple',
    research_ready INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    assigned_to TEXT,
    dependencies TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    output TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (created_by) REFERENCES agents(id),
    FOREIGN KEY (assigned_to) REFERENCES agents(id)
);

-- Memory table
CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    created_by TEXT,
    ttl_seconds INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    UNIQUE(namespace, key),
    FOREIGN KEY (created_by) REFERENCES agents(id)
);

-- Locks table
CREATE TABLE IF NOT EXISTS locks (
    id TEXT PRIMARY KEY,
    resource TEXT NOT NULL UNIQUE,
    held_by TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (held_by) REFERENCES agents(id)
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    agent_id TEXT,
    resource_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_memory_namespace_key ON memory(namespace, key);
CREATE INDEX IF NOT EXISTS idx_locks_resource ON locks(resource);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_agent_id ON events(agent_id);
`;

type DbRow = Record<string, unknown>;

export class OrchestratorDatabase {
  private db: Database.Database;
  public readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? getDbPath();

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency (multiple agents)
    this.db.pragma('journal_mode = WAL');
    // Set busy timeout to wait up to 5 seconds if database is locked
    this.db.pragma('busy_timeout = 5000');
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Create schema
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ==================== Agent Operations ====================

  createAgent(params: {
    name: string;
    role?: AgentRole;
    capabilities?: string[];
    status?: AgentStatus;
    metadata?: Record<string, unknown>;
  }): Agent {
    const agent = createAgent(params);

    this.db
      .prepare(
        `INSERT INTO agents (id, name, role, status, capabilities, metadata, registered_at, last_heartbeat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        agent.id,
        agent.name,
        agent.role,
        agent.status,
        JSON.stringify(agent.capabilities),
        JSON.stringify(agent.metadata),
        agent.registeredAt.toISOString(),
        agent.lastHeartbeat.toISOString()
      );

    this.logEvent(EventType.AGENT_REGISTERED, agent.id, agent.id, { name: agent.name });
    return agent;
  }

  getAgent(agentId: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as
      | DbRow
      | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  getAgentByName(name: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as
      | DbRow
      | undefined;
    return row ? this.rowToAgent(row) : null;
  }

  listAgents(filters?: { status?: AgentStatus; role?: AgentRole }): Agent[] {
    let query = 'SELECT * FROM agents WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.role) {
      query += ' AND role = ?';
      params.push(filters.role);
    }

    query += ' ORDER BY registered_at DESC';

    const rows = this.db.prepare(query).all(...params) as DbRow[];
    return rows.map((row) => this.rowToAgent(row));
  }

  updateAgentHeartbeat(agentId: string, status?: AgentStatus): boolean {
    const now = new Date().toISOString();

    let result;
    if (status) {
      result = this.db
        .prepare('UPDATE agents SET last_heartbeat = ?, status = ? WHERE id = ?')
        .run(now, status, agentId);
    } else {
      result = this.db
        .prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?')
        .run(now, agentId);
    }

    return result.changes > 0;
  }

  deleteAgent(agentId: string): boolean {
    // First release any locks held by this agent
    this.releaseAgentLocks(agentId);

    const result = this.db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
    if (result.changes > 0) {
      this.logEvent(EventType.AGENT_UNREGISTERED, agentId, agentId);
      return true;
    }
    return false;
  }

  private rowToAgent(row: DbRow): Agent {
    return {
      id: row.id as string,
      name: row.name as string,
      role: row.role as AgentRole,
      status: row.status as AgentStatus,
      capabilities: JSON.parse(row.capabilities as string) as string[],
      metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
      registeredAt: new Date(row.registered_at as string),
      lastHeartbeat: new Date(row.last_heartbeat as string),
    };
  }

  cleanupStaleAgents(ttlSeconds: number = HEARTBEAT_TTL_SECONDS): number {
    const cutoff = new Date(Date.now() - ttlSeconds * 1000).toISOString();

    // Get stale agents first (so we can release their locks)
    const staleAgents = this.db
      .prepare("SELECT id FROM agents WHERE status != 'offline' AND last_heartbeat < ?")
      .all(cutoff) as Array<{ id: string }>;

    if (staleAgents.length === 0) {
      return 0;
    }

    // Release locks for stale agents
    for (const agent of staleAgents) {
      this.releaseAgentLocks(agent.id);
    }

    // Mark them as offline
    const result = this.db
      .prepare(
        "UPDATE agents SET status = 'offline' WHERE status != 'offline' AND last_heartbeat < ?"
      )
      .run(cutoff);

    return result.changes;
  }

  // ==================== Task Operations ====================

  createTask(params: {
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
    const task = createTask(params);

    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, priority, complexity, research_ready, created_by, assigned_to,
                          dependencies, metadata, output, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.complexity,
        task.researchReady ? 1 : 0,
        task.createdBy,
        task.assignedTo,
        JSON.stringify(task.dependencies),
        JSON.stringify(task.metadata),
        task.output,
        task.createdAt.toISOString(),
        task.updatedAt.toISOString(),
        task.startedAt?.toISOString() ?? null,
        task.completedAt?.toISOString() ?? null
      );

    this.logEvent(EventType.TASK_CREATED, task.createdBy, task.id, { title: task.title, complexity: task.complexity });
    return task;
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | DbRow
      | undefined;
    return row ? this.rowToTask(row) : null;
  }

  listTasks(filters?: {
    status?: TaskStatus;
    assignedTo?: string;
    createdBy?: string;
  }): Task[] {
    let query = 'SELECT * FROM tasks WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.assignedTo) {
      query += ' AND assigned_to = ?';
      params.push(filters.assignedTo);
    }
    if (filters?.createdBy) {
      query += ' AND created_by = ?';
      params.push(filters.createdBy);
    }

    query +=
      " ORDER BY CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, created_at ASC";

    const rows = this.db.prepare(query).all(...params) as DbRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  updateTask(
    taskId: string,
    updates: {
      status?: TaskStatus;
      assignedTo?: string | null;
      output?: string;
      metadata?: Record<string, unknown>;
      researchReady?: boolean;
      complexity?: TaskComplexity;
    }
  ): Task | null {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }

    const setClauses: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];

    if (updates.status !== undefined) {
      setClauses.push('status = ?');
      params.push(updates.status);

      if (updates.status === TaskStatus.IN_PROGRESS && !task.startedAt) {
        setClauses.push('started_at = ?');
        params.push(new Date().toISOString());
      } else if (
        [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED].includes(updates.status)
      ) {
        setClauses.push('completed_at = ?');
        params.push(new Date().toISOString());
      }
    }

    if (updates.assignedTo !== undefined) {
      setClauses.push('assigned_to = ?');
      params.push(updates.assignedTo);
    }

    if (updates.output !== undefined) {
      setClauses.push('output = ?');
      params.push(updates.output);
    }

    if (updates.metadata !== undefined) {
      // Merge with existing metadata
      const merged = { ...task.metadata, ...updates.metadata };
      setClauses.push('metadata = ?');
      params.push(JSON.stringify(merged));
    }

    if (updates.researchReady !== undefined) {
      setClauses.push('research_ready = ?');
      params.push(updates.researchReady ? 1 : 0);
    }

    if (updates.complexity !== undefined) {
      setClauses.push('complexity = ?');
      params.push(updates.complexity);
    }

    params.push(taskId);
    const query = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(query).run(...params);

    // Log appropriate event
    let eventType = EventType.TASK_UPDATED;
    if (updates.status === TaskStatus.ASSIGNED) {
      eventType = EventType.TASK_ASSIGNED;
    } else if (updates.status === TaskStatus.IN_PROGRESS) {
      eventType = EventType.TASK_CLAIMED;
    } else if (updates.status === TaskStatus.COMPLETED) {
      eventType = EventType.TASK_COMPLETED;
    }

    this.logEvent(eventType, updates.assignedTo ?? task.assignedTo, taskId);

    return this.getTask(taskId);
  }

  checkDependenciesMet(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task || task.dependencies.length === 0) {
      return true;
    }

    for (const depId of task.dependencies) {
      const depTask = this.getTask(depId);
      if (!depTask || depTask.status !== TaskStatus.COMPLETED) {
        return false;
      }
    }
    return true;
  }

  getNextAvailableTask(agentId: string): Task | null {
    // Get tasks that are pending or assigned to this agent
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks 
       WHERE (status = 'pending' OR (status = 'assigned' AND assigned_to = ?))
       ORDER BY 
           CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
           created_at ASC`
      )
      .all(agentId) as DbRow[];

    for (const row of rows) {
      const task = this.rowToTask(row);
      if (this.checkDependenciesMet(task.id)) {
        return task;
      }
    }
    return null;
  }

  private rowToTask(row: DbRow): Task {
    return {
      id: row.id as string,
      title: row.title as string,
      description: row.description as string,
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      complexity: (row.complexity as TaskComplexity) ?? TaskComplexity.SIMPLE,
      researchReady: Boolean(row.research_ready),
      createdBy: row.created_by as string | null,
      assignedTo: row.assigned_to as string | null,
      dependencies: JSON.parse(row.dependencies as string) as string[],
      metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
      output: row.output as string | null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      startedAt: row.started_at ? new Date(row.started_at as string) : null,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    };
  }

  // ==================== Research Operations ====================

  /**
   * Get research status for a task
   * Returns which research items are completed and which are missing
   */
  getResearchStatus(taskId: string): {
    task: Task | null;
    required: string[];
    completed: string[];
    missing: string[];
    isReady: boolean;
  } {
    const task = this.getTask(taskId);
    if (!task) {
      return { task: null, required: [], completed: [], missing: [], isReady: false };
    }

    const required = RESEARCH_REQUIREMENTS[task.complexity] || [];
    
    // If no research required (trivial), it's ready
    if (required.length === 0) {
      return { task, required: [], completed: [], missing: [], isReady: true };
    }

    // Check what research has been documented
    const completed: string[] = [];
    const missing: string[] = [];

    for (const item of required) {
      const namespace = `research:${taskId}:${item}`;
      const entries = this.listMemory(namespace);
      if (entries.length > 0) {
        completed.push(item);
      } else {
        missing.push(item);
      }
    }

    return {
      task,
      required,
      completed,
      missing,
      isReady: missing.length === 0,
    };
  }

  /**
   * Mark a task as research-ready (validates that all required research is done)
   */
  markResearchReady(taskId: string): { success: boolean; message: string; task?: Task } {
    const status = this.getResearchStatus(taskId);
    
    if (!status.task) {
      return { success: false, message: `Task ${taskId} not found.` };
    }

    if (status.task.researchReady) {
      return { success: true, message: 'Research already marked as ready.', task: status.task };
    }

    if (!status.isReady) {
      return {
        success: false,
        message: `Research incomplete. Missing: ${status.missing.join(', ')}. Use memory_set with namespace "research:${taskId}:<item>" to document each.`,
      };
    }

    const updated = this.updateTask(taskId, { researchReady: true });
    return {
      success: true,
      message: 'Research marked as complete. You may now implement.',
      task: updated ?? undefined,
    };
  }

  /**
   * Search research findings across all tasks
   */
  searchResearch(query: string, limit: number = 20): MemoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory 
         WHERE namespace LIKE 'research:%' 
         AND (key LIKE ? OR value LIKE ?)
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit) as DbRow[];

    return rows.map((row) => this.rowToMemory(row));
  }

  /**
   * Get all research for a specific task
   */
  getTaskResearch(taskId: string): Record<string, MemoryEntry[]> {
    const result: Record<string, MemoryEntry[]> = {};
    const categories = ['context', 'files', 'requirements', 'design'];

    for (const category of categories) {
      const namespace = `research:${taskId}:${category}`;
      const entries = this.listMemory(namespace);
      if (entries.length > 0) {
        result[category] = entries;
      }
    }

    return result;
  }

  // ==================== Memory Operations ====================

  setMemory(params: {
    key: string;
    value: unknown;
    namespace?: string;
    createdBy?: string | null;
    ttlSeconds?: number | null;
  }): MemoryEntry {
    const entry = createMemoryEntry(params);

    // Upsert: insert or replace
    this.db
      .prepare(
        `INSERT INTO memory (id, key, value, namespace, created_by, ttl_seconds, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           ttl_seconds = excluded.ttl_seconds,
           expires_at = excluded.expires_at`
      )
      .run(
        entry.id,
        entry.key,
        JSON.stringify(entry.value),
        entry.namespace,
        entry.createdBy,
        entry.ttlSeconds,
        entry.createdAt.toISOString(),
        entry.updatedAt.toISOString(),
        entry.expiresAt?.toISOString() ?? null
      );

    this.logEvent(EventType.MEMORY_SET, entry.createdBy, entry.key, {
      namespace: entry.namespace,
    });
    return entry;
  }

  getMemory(key: string, namespace: string = 'default'): MemoryEntry | null {
    // Clean up expired entries first
    this.cleanupExpiredMemory();

    const row = this.db
      .prepare('SELECT * FROM memory WHERE namespace = ? AND key = ?')
      .get(namespace, key) as DbRow | undefined;

    return row ? this.rowToMemory(row) : null;
  }

  listMemory(namespace: string = 'default'): MemoryEntry[] {
    this.cleanupExpiredMemory();

    const rows = this.db
      .prepare('SELECT * FROM memory WHERE namespace = ? ORDER BY key')
      .all(namespace) as DbRow[];

    return rows.map((row) => this.rowToMemory(row));
  }

  deleteMemory(key: string, namespace: string = 'default'): boolean {
    const result = this.db
      .prepare('DELETE FROM memory WHERE namespace = ? AND key = ?')
      .run(namespace, key);

    if (result.changes > 0) {
      this.logEvent(EventType.MEMORY_DELETE, null, key, { namespace });
      return true;
    }
    return false;
  }

  private cleanupExpiredMemory(): void {
    const now = new Date().toISOString();
    this.db
      .prepare('DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at < ?')
      .run(now);
  }

  private rowToMemory(row: DbRow): MemoryEntry {
    return {
      id: row.id as string,
      key: row.key as string,
      value: JSON.parse(row.value as string) as unknown,
      namespace: row.namespace as string,
      createdBy: row.created_by as string | null,
      ttlSeconds: row.ttl_seconds as number | null,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    };
  }

  // ==================== Lock Operations ====================

  acquireLock(params: {
    resource: string;
    heldBy: string;
    timeoutSeconds?: number;
    metadata?: Record<string, unknown>;
  }): Lock | null {
    // Clean up expired locks first
    this.cleanupExpiredLocks();

    const lock = createLock(params);

    try {
      this.db
        .prepare(
          `INSERT INTO locks (id, resource, held_by, acquired_at, expires_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          lock.id,
          lock.resource,
          lock.heldBy,
          lock.acquiredAt.toISOString(),
          lock.expiresAt?.toISOString() ?? null,
          JSON.stringify(lock.metadata)
        );

      this.logEvent(EventType.LOCK_ACQUIRED, lock.heldBy, lock.resource);
      return lock;
    } catch (error) {
      // Lock already held (UNIQUE constraint violation)
      if ((error as Error).message.includes('UNIQUE constraint failed')) {
        return null;
      }
      throw error;
    }
  }

  releaseLock(resource: string, agentId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM locks WHERE resource = ? AND held_by = ?')
      .run(resource, agentId);

    if (result.changes > 0) {
      this.logEvent(EventType.LOCK_RELEASED, agentId, resource);
      return true;
    }
    return false;
  }

  releaseAgentLocks(agentId: string): number {
    const result = this.db.prepare('DELETE FROM locks WHERE held_by = ?').run(agentId);
    return result.changes;
  }

  checkLock(resource: string): Lock | null {
    this.cleanupExpiredLocks();

    const row = this.db.prepare('SELECT * FROM locks WHERE resource = ?').get(resource) as
      | DbRow
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id as string,
      resource: row.resource as string,
      heldBy: row.held_by as string,
      acquiredAt: new Date(row.acquired_at as string),
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
      metadata: JSON.parse(row.metadata as string) as Record<string, unknown>,
    };
  }

  private cleanupExpiredLocks(): void {
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM locks WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  }

  // ==================== Event Operations ====================

  private logEvent(
    eventType: EventType,
    agentId: string | null,
    resourceId: string | null,
    details?: Record<string, unknown>
  ): void {
    const event = createEvent({ eventType, agentId, resourceId, details });

    this.db
      .prepare(
        `INSERT INTO events (id, event_type, agent_id, resource_id, details, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.eventType,
        event.agentId,
        event.resourceId,
        JSON.stringify(event.details),
        event.timestamp.toISOString()
      );
  }

  listEvents(filters?: {
    agentId?: string;
    eventType?: EventType;
    limit?: number;
  }): Event[] {
    let query = 'SELECT * FROM events WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.agentId) {
      query += ' AND agent_id = ?';
      params.push(filters.agentId);
    }
    if (filters?.eventType) {
      query += ' AND event_type = ?';
      params.push(filters.eventType);
    }

    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(filters?.limit ?? 100);

    const rows = this.db.prepare(query).all(...params) as DbRow[];

    return rows.map((row) => ({
      id: row.id as string,
      eventType: row.event_type as EventType,
      agentId: row.agent_id as string | null,
      resourceId: row.resource_id as string | null,
      details: JSON.parse(row.details as string) as Record<string, unknown>,
      timestamp: new Date(row.timestamp as string),
    }));
  }

  // ==================== Stats ====================

  getStats(): { agents: number; tasks: number; locks: number; memory: number } {
    const agents = (
      this.db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }
    ).count;
    const tasks = (
      this.db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number }
    ).count;
    const locks = (
      this.db.prepare('SELECT COUNT(*) as count FROM locks').get() as { count: number }
    ).count;
    const memory = (
      this.db.prepare('SELECT COUNT(*) as count FROM memory').get() as { count: number }
    ).count;

    return { agents, tasks, locks, memory };
  }
}

// ==================== Global Instance ====================

let _db: OrchestratorDatabase | null = null;

export function getDatabase(): OrchestratorDatabase {
  if (!_db) {
    _db = new OrchestratorDatabase();
  }
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
