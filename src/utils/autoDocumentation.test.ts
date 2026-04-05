import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { closeDatabase, getDatabase } from '../database.js';
import { generateTaskDocumentation } from './autoDocumentation.js';

test('generates task documentation markdown and index files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-orch-docs-'));
  const previousDbPath = process.env.MCP_ORCH_DB_PATH;
  process.env.MCP_ORCH_DB_PATH = path.join(tmpDir, 'orchestrator.db');

  closeDatabase();

  try {
    const db = getDatabase();
    const task = db.createTask({
      title: 'Generate docs',
      description: 'Create a task documentation artifact.',
    });

    db.setMemory({
      namespace: 'context',
      key: 'current_focus',
      value: 'Validate generated task documentation.',
    });

    db.updateTask(task.id, {
      output: 'Documentation was generated successfully.',
    });

    const generated = generateTaskDocumentation(db, task.id, tmpDir);
    assert.ok(generated);
    assert.equal(fs.existsSync(generated.taskDocPath), true);
    assert.equal(fs.existsSync(generated.indexDocPath), true);

    const taskDoc = fs.readFileSync(generated.taskDocPath, 'utf-8');
    const indexDoc = fs.readFileSync(generated.indexDocPath, 'utf-8');

    assert.match(taskDoc, /# Task Documentation: Generate docs/);
    assert.match(taskDoc, /Documentation was generated successfully\./);
    assert.match(indexDoc, /Generate docs/);
  } finally {
    closeDatabase();
    if (previousDbPath === undefined) {
      delete process.env.MCP_ORCH_DB_PATH;
    } else {
      process.env.MCP_ORCH_DB_PATH = previousDbPath;
    }
  }
});
