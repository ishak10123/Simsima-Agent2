import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

const now = () => new Date().toISOString();
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

export class Store {
  constructor(dataDir, { isProcessAlive = alive } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'simsima.sqlite'));
    this.isProcessAlive = isProcessAlive;
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, account TEXT NOT NULL, weighted_length INTEGER NOT NULL,
        image_name TEXT, image_mime TEXT, image_sha256 TEXT, image_bytes BLOB, created_at TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'x'
      );
      CREATE TABLE IF NOT EXISTS operations (
        request_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id),
        status TEXT NOT NULL CHECK(status IN ('running','submitting','succeeded','failed','uncertain')),
        owner_pid INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        post_id TEXT, post_url TEXT, evidence TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS operations_draft ON operations(draft_id);
      CREATE INDEX IF NOT EXISTS operations_status ON operations(status);`);
    if (!this.db.prepare('PRAGMA table_info(drafts)').all().some(column => column.name === 'platform')) {
      this.db.exec("ALTER TABLE drafts ADD COLUMN platform TEXT NOT NULL DEFAULT 'x'");
    }
    this.recover();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  recover() {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM operations WHERE status IN ('running','submitting')").all()) {
        if (!this.isProcessAlive(row.owner_pid)) {
          const status = row.status === 'submitting' ? 'uncertain' : 'failed';
          const error = { code: 'interrupted', message: status === 'uncertain'
            ? 'توقف التنفيذ بعد بدء الإرسال؛ لا تعاود نشر هذه المسودة قبل التحقق من الحساب.'
            : 'توقف التنفيذ قبل الإرسال. يمكن تجهيز محاولة جديدة.' };
          this.db.prepare('UPDATE operations SET status=?, error=?, updated_at=? WHERE request_id=?')
            .run(status, JSON.stringify(error), now(), row.request_id);
        }
      }
    });
  }

  createDraft({ text, account, weightedLength, image, platform = 'x' }) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO drafts(id,text,account,weighted_length,image_name,image_mime,image_sha256,image_bytes,created_at,platform) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, text, account, weightedLength,
      image?.name ?? null, image?.mimeType ?? null, image?.sha256 ?? null, image?.bytes ?? null, now(), platform);
    return this.publicDraft(this.getDraft(id));
  }

  getDraft(id) {
    const row = this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
    if (!row) throw new AppError('draft_not_found', 'لم يُعثر على المسودة.');
    return row;
  }

  publicDraft(row) {
    return { draft_id: row.id, platform: row.platform, text: row.text,
      ...(row.platform !== 'x' ? { channel_id: row.account, text_length: row.weighted_length }
        : { account: `@${row.account}`, weighted_length: row.weighted_length }),
      image: row.image_sha256 ? { name: row.image_name, mime_type: row.image_mime,
        sha256: row.image_sha256, bytes: row.image_bytes.length } : null, created_at: row.created_at };
  }

  getOperation(id) {
    const row = this.db.prepare('SELECT operations.*,drafts.platform FROM operations JOIN drafts ON drafts.id=operations.draft_id WHERE request_id=?').get(id);
    if (!row) throw new AppError('operation_not_found', 'لم يُعثر على عملية بهذا المعرّف.');
    return { request_id: row.request_id, draft_id: row.draft_id, platform: row.platform, status: row.status,
      post_id: row.post_id, post_url: row.post_url, created_at: row.created_at, updated_at: row.updated_at,
      evidence: row.evidence ? JSON.parse(row.evidence) : null, error: row.error ? JSON.parse(row.error) : null };
  }

  claim(requestId, draftId) {
    this.recover();
    return this.transaction(() => {
      this.getDraft(draftId);
      const existing = this.db.prepare('SELECT draft_id FROM operations WHERE request_id=?').get(requestId);
      if (existing) {
        if (existing.draft_id !== draftId) throw new AppError('request_conflict', 'معرّف العملية مرتبط بمسودة أخرى.');
        return { acquired: false, operation: this.getOperation(requestId) };
      }
      if (this.db.prepare("SELECT 1 FROM operations WHERE draft_id=? AND status IN ('submitting','succeeded','uncertain')").get(draftId)) {
        throw new AppError('draft_already_submitted', 'هذه المسودة أُرسلت أو نتيجتها غير محسومة. لا تُرسل مرة أخرى.');
      }
      if (this.db.prepare("SELECT 1 FROM operations WHERE status IN ('running','submitting')").get()) {
        throw new AppError('browser_busy', 'توجد عملية نشر أخرى قيد التنفيذ. انتظر نتيجتها.');
      }
      const timestamp = now();
      this.db.prepare('INSERT INTO operations(request_id,draft_id,status,owner_pid,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(requestId, draftId, 'running', process.pid, timestamp, timestamp);
      return { acquired: true, operation: this.getOperation(requestId) };
    });
  }

  markSubmitting(id) {
    const result = this.db.prepare("UPDATE operations SET status='submitting',updated_at=? WHERE request_id=? AND status='running'").run(now(), id);
    if (result.changes !== 1) throw new AppError('invalid_operation_state', 'لا يمكن بدء الإرسال في الحالة الحالية.');
  }

  recordCandidate(id, candidate) {
    this.db.prepare("UPDATE operations SET post_id=?,post_url=?,evidence=?,updated_at=? WHERE request_id=? AND status='submitting'")
      .run(candidate.post_id, candidate.post_url, JSON.stringify(candidate.evidence), now(), id);
  }

  finish(id, { result, error, notCreated = false }) {
    return this.transaction(() => {
      const op = this.getOperation(id);
      const verifiedRecovery = op.status === 'uncertain' && result?.post_id === op.post_id
        && Boolean(op.post_id) && result?.evidence?.permalink_verified === true;
      if (!['running', 'submitting'].includes(op.status) && !verifiedRecovery) return op;
      const status = result ? 'succeeded' : op.status === 'submitting' && !notCreated ? 'uncertain' : 'failed';
      if (result && op.status !== 'submitting' && !verifiedRecovery) throw new AppError('invalid_operation_state', 'لا يوجد إرسال مسجل لهذه العملية.');
      this.db.prepare('UPDATE operations SET status=?,post_id=?,post_url=?,evidence=?,error=?,updated_at=? WHERE request_id=?')
        .run(status, result?.post_id ?? op.post_id, result?.post_url ?? op.post_url,
          JSON.stringify(result?.evidence ?? op.evidence), error ? JSON.stringify(error) : null, now(), id);
      return this.getOperation(id);
    });
  }

  close() { this.db.close(); }
}
