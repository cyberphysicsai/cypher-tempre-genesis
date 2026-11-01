/** Read only a disposable fixture's real pinned native SQLite transcript. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function nativeCompactionSnapshot({ nodePath, stateDir, sessionKey, packageRoot, sessionTarget }) {
  if (packageRoot || sessionTarget) assert.ok(packageRoot && sessionTarget, 'A public SDK probe requires the actual trusted native target.');
  const { stdout } = await promisify(execFile)(nodePath, [fileURLToPath(import.meta.url), stateDir, sessionKey,
    ...(packageRoot && sessionTarget ? [JSON.stringify({ packageRoot, sessionTarget })] : [])], {
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCLAW_|CHAINCHAT_)/i.test(name))),
      OPENCLAW_STATE_DIR: path.join(stateDir, 'native-state'), OPENCLAW_CONFIG_PATH: path.join(stateDir, 'gateway.json') },
  });
  return JSON.parse(stdout);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { DatabaseSync } = await import('node:sqlite'), { zstdDecompressSync } = await import('node:zlib');
  const stateDir = await fs.realpath(process.argv[2]), sessionKey = process.argv[3];
  assert.match(path.basename(path.dirname(stateDir)), /^ct-(?:cmp|lcmp)-/);
  assert.match(sessionKey, /^agent:main:chainchat-control:[a-f0-9]{64}$/);
  const file = path.join(stateDir, 'native-state', 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  assert.equal(await fs.realpath(file), file);
  const database = new DatabaseSync(file, { readOnly: true });
  let snapshot, currentSessionId;
  try {
    database.exec('BEGIN');
    const windows = database.prepare('SELECT session_id, reason FROM session_windows WHERE session_key = ? ORDER BY session_id').all(sessionKey);
    assert.ok(windows.length > 0, 'The expected real native logical session must exist.');
    currentSessionId = database.prepare('SELECT current_session_id FROM session_nodes WHERE session_key = ?').get(sessionKey)?.current_session_id;
    const rows = database.prepare(`SELECT e.session_id, e.seq, e.event_json, e.event_zstd, e.event_utf8_bytes
      FROM transcript_events e JOIN session_windows w ON e.session_id = w.session_id
      WHERE w.session_key = ? ORDER BY e.session_id, e.seq`).all(sessionKey);
    assert.ok(rows.length >= 6, 'The acceptance fixture must contain real persisted conversation events.');
    const events = rows.map(row => {
      const raw = row.event_json ?? zstdDecompressSync(Buffer.from(row.event_zstd), { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8');
      if (row.event_json === null) assert.equal(Buffer.byteLength(raw), row.event_utf8_bytes);
      return { row, raw, event: JSON.parse(raw) };
    });
    const compactions = events.filter(({ event }) => event.type === 'compaction').map(({ row, raw, event }) => {
      const first = events.findIndex(item => item.row.session_id === row.session_id && item.event.id === event.firstKeptEntryId);
      const retained = events.filter((item, index) => first >= 0 && index >= first && item.row.session_id === row.session_id && item.row.seq < row.seq);
      return { id: event.id, sessionId: row.session_id, seq: row.seq, sha256: createHash('sha256').update(raw).digest('hex'),
        summary: event.summary, firstKeptEntryId: event.firstKeptEntryId, details: event.details,
        retainedUserTurns: retained.filter(item => item.event.type === 'message' && item.event.message?.role === 'user' && item.event.message.excludeFromContext !== true).length,
        retainedAssistantMessages: retained.filter(item => item.event.type === 'message' && item.event.message?.role === 'assistant').length,
        retainedToolCalls: retained.filter(item => item.event.type === 'message' && item.event.message?.role === 'assistant').flatMap(item => (item.event.message.content || []).filter(block => block.type === 'toolCall').map(block => block.id)).sort(),
        retainedToolResults: retained.filter(item => item.event.type === 'message' && item.event.message?.role === 'toolResult').map(item => item.event.message.toolCallId).sort() };
    });
    const sourceEvents = events.filter(({ event }) => event.type !== 'compaction').map(({ row, raw }) => ({
      sessionId: row.session_id, seq: row.seq, sha256: createHash('sha256').update(raw).digest('hex') }));
    const recentUserInputs = events.filter(({ event }) => event.type === 'message' && event.message?.role === 'user').slice(-3).map(({ event }) => {
      const content = event.message.content;
      return (typeof content === 'string' ? content : (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')).slice(0, 256);
    });
    snapshot = { windows, eventCount: events.length, compactions, sourceEvents, recentUserInputs };
  } finally { database.close(); }
  if (process.argv[4]) {
    const { packageRoot, sessionTarget } = JSON.parse(process.argv[4]);
    assert.equal(sessionTarget.agentId, 'main'); assert.equal(sessionTarget.sessionKey, sessionKey); assert.equal(sessionTarget.sessionId, currentSessionId);
    const relative = path.relative(stateDir, path.resolve(sessionTarget.storePath));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    assert.equal(JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8')).version, '2026.10.9');
    const { SessionManager, buildSessionContext } = await import(pathToFileURL(path.join(packageRoot, 'dist/plugin-sdk/agent-sessions.js')).href);
    const manager = await SessionManager.openAsync(sessionTarget, stateDir), branch = manager.getBranch(), messages = buildSessionContext(branch).messages;
    const persistedBoundary = snapshot.compactions.filter(entry => entry.sessionId === currentSessionId).at(-1);
    assert.ok(persistedBoundary?.details?.retainedCompleteTurns >= 2, 'The actual automatic boundary must retain two complete prior native turns.');
    assert.ok(persistedBoundary.retainedUserTurns >= 2 && persistedBoundary.retainedAssistantMessages >= 2);
    const activeCompactions = branch.filter(entry => entry.type === 'compaction');
    const view = JSON.stringify(messages), latest = activeCompactions.at(-1);
    const digest = value => createHash('sha256').update(value || '').digest('hex');
    const metadata = { expectedBoundaryId: persistedBoundary.id, expectedFirstKeptEntryId: persistedBoundary.firstKeptEntryId,
      activeCompactions: activeCompactions.map(entry => ({ id: entry.id, firstKeptEntryId: entry.firstKeptEntryId, summarySha256: digest(entry.summary) })),
      messageRoles: messages.map(message => message.role), expectedSummarySha256: digest(persistedBoundary.summary) };
    assert.equal(latest?.id, persistedBoundary.id, 'The current SDK branch must retain the actual latest persisted boundary: ' + JSON.stringify(metadata));
    assert.equal(latest.firstKeptEntryId, persistedBoundary.firstKeptEntryId);
    assert.equal(latest.summary, persistedBoundary.summary);
    snapshot.sdk = { ...metadata, modelViewContainsLatestSummary: messages.some(message => message.role === 'compactionSummary' && message.summary === persistedBoundary.summary),
      modelViewHasOldSourcePadding: view.includes('source-padding'), modelViewHasPendingMarker: view.includes('CT_PENDING_ONLY_CURRENT_BOUNDARY'),
      messageCount: messages.length };
  }
  process.stdout.write(JSON.stringify(snapshot), () => process.exit(0));
}
