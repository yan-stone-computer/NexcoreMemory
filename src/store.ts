import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEdge, MemoryNode, MemoryRecallItem, MemoryRecallRecord, MemoryRecord } from "./types.ts";

function terms(value: string): string[] {
  const parts = value.toLowerCase().normalize("NFKC").match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || [];
  return parts.flatMap(part => /\p{Script=Han}/u.test(part) && part.length > 1
    ? Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2))
    : [part]);
}

export class MemoryStore {
  readonly db: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "nexcore-memory.db"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED, workspace UNINDEXED, layer UNINDEXED, status UNINDEXED, topic, content, terms
      );
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
        canonical_name TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_node_workspace ON memory_nodes(workspace,type);
      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, source_node TEXT NOT NULL, relation TEXT NOT NULL,
        target_node TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, valid_from INTEGER NOT NULL,
        valid_to INTEGER, source_memory_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_edge_source ON memory_edges(workspace,source_node);
      CREATE INDEX IF NOT EXISTS memory_edge_target ON memory_edges(workspace,target_node);
      CREATE TABLE IF NOT EXISTS recall_log (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT NOT NULL, workspace TEXT NOT NULL,
        query TEXT NOT NULL, candidate_count INTEGER NOT NULL, selected TEXT NOT NULL,
        omitted TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS recall_log_workspace ON recall_log(workspace,created_at);`);
  }

  putMemory(input: Omit<MemoryRecord, "id" | "createdAt" | "updatedAt"> & Partial<Pick<MemoryRecord, "id" | "createdAt" | "updatedAt">>): MemoryRecord {
    const old = input.id ? this.getMemory(input.id) : undefined;
    const now = Date.now();
    const record: MemoryRecord = {
      ...old,
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt || old?.createdAt || now,
      updatedAt: input.updatedAt || now
    };
    this.db.prepare("INSERT INTO memories(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(record.id, JSON.stringify(record));
    this.reindex(record);
    return record;
  }

  setStatus(id: string, status: MemoryRecord["status"]): MemoryRecord {
    const record = this.getMemory(id);
    if (!record) throw new Error(`Memory not found: ${id}`);
    return this.putMemory({ ...record, status, updatedAt: Date.now() });
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT data FROM memories WHERE id=?").get(id);
    return row ? JSON.parse(String(row.data)) as MemoryRecord : undefined;
  }

  listMemories(includeInactive = false): MemoryRecord[] {
    return this.db.prepare("SELECT data FROM memories ORDER BY json_extract(data,'$.updatedAt') DESC").all()
      .map(row => JSON.parse(String(row.data)) as MemoryRecord)
      .filter(item => includeInactive || (item.status !== "deleted" && item.status !== "superseded"));
  }

  candidates(query: string, workspace: string, limit = 64, fallback = ""): { item: MemoryRecord; lexical: number }[] {
    const queryTerms = [...new Set(terms(query))].slice(0, 30);
    const pinned = this.listMemories()
      .filter(item => (item.workspace === workspace || (Boolean(fallback) && workspace === fallback && !item.workspace)) && (item.pinned || item.layer === "L3"))
      .slice(0, 12)
      .map(item => ({ item, lexical: item.pinned ? 0.2 : 0.1 }));
    const byId = new Map(pinned.map(row => [row.item.id, row]));
    if (!queryTerms.length) return [...byId.values()];
    const match = queryTerms.map(item => `"${item.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.db.prepare(`SELECT id FROM memory_fts
      WHERE memory_fts MATCH ? AND (workspace=? OR (?<>'' AND workspace='')) AND status IN ('active','suppressed')
      ORDER BY bm25(memory_fts) LIMIT ?`).all(match, workspace, fallback, limit);
    rows.forEach((row, index) => {
      const item = this.getMemory(String(row.id));
      if (!item || (item.workspace !== workspace && !(fallback && workspace === fallback && !item.workspace))) return;
      if (item.status === "deleted" || item.status === "superseded" || (item.validTo && item.validTo < Date.now())) return;
      if (!byId.has(item.id)) byId.set(item.id, { item, lexical: 1 / (index + 1) });
    });
    return [...byId.values()].slice(0, limit);
  }

  putGraph(memoryId: string, nodes: MemoryNode[], edges: MemoryEdge[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM memory_edges WHERE source_memory_id=?").run(memoryId);
      const nodeStatement = this.db.prepare(`INSERT INTO memory_nodes(id,workspace,type,name,canonical_name,importance,last_seen_at)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,canonical_name=excluded.canonical_name,
        importance=MAX(memory_nodes.importance,excluded.importance),last_seen_at=MAX(memory_nodes.last_seen_at,excluded.last_seen_at)`);
      for (const node of nodes) nodeStatement.run(node.id, node.workspace, node.type, node.name, node.canonicalName, node.importance, node.lastSeenAt);
      const edgeStatement = this.db.prepare(`INSERT INTO memory_edges(id,workspace,source_node,relation,target_node,confidence,valid_from,valid_to,source_memory_id)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence,valid_from=excluded.valid_from,valid_to=excluded.valid_to`);
      for (const edge of edges) edgeStatement.run(edge.id, edge.workspace, edge.sourceNode, edge.relation, edge.targetNode, edge.confidence, edge.validFrom, edge.validTo ?? null, edge.sourceMemoryId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  nodes(workspace: string): MemoryNode[] {
    return this.db.prepare("SELECT * FROM memory_nodes WHERE workspace=? ORDER BY importance DESC,last_seen_at DESC").all(workspace)
      .map(row => ({
        id: String(row.id), workspace: String(row.workspace), type: String(row.type) as MemoryNode["type"],
        name: String(row.name), canonicalName: String(row.canonical_name), importance: Number(row.importance), lastSeenAt: Number(row.last_seen_at)
      }));
  }

  edges(workspace: string): MemoryEdge[] {
    return this.db.prepare("SELECT * FROM memory_edges WHERE workspace=? ORDER BY valid_from DESC").all(workspace)
      .map(row => ({
        id: String(row.id), workspace: String(row.workspace), sourceNode: String(row.source_node),
        relation: String(row.relation) as MemoryEdge["relation"], targetNode: String(row.target_node),
        confidence: Number(row.confidence), validFrom: Number(row.valid_from),
        ...(row.valid_to === null ? {} : { validTo: Number(row.valid_to) }),
        sourceMemoryId: String(row.source_memory_id)
      }));
  }

  putRecall(record: MemoryRecallRecord): MemoryRecallRecord {
    this.db.prepare(`INSERT INTO recall_log(id,run_id,session_id,workspace,query,candidate_count,selected,omitted,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      record.id, record.runId, record.sessionId, record.workspace, record.query, record.candidateCount,
      JSON.stringify(record.selected), JSON.stringify(record.omitted), record.createdAt
    );
    this.db.prepare(`DELETE FROM recall_log WHERE workspace=? AND id NOT IN (
      SELECT id FROM recall_log WHERE workspace=? ORDER BY created_at DESC LIMIT 1000
    )`).run(record.workspace, record.workspace);
    return record;
  }

  recallLogs(workspace?: string, limit = 100): MemoryRecallRecord[] {
    const rows = workspace
      ? this.db.prepare("SELECT * FROM recall_log WHERE workspace=? ORDER BY created_at DESC LIMIT ?").all(workspace, limit)
      : this.db.prepare("SELECT * FROM recall_log ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map(row => ({
      id: String(row.id), runId: String(row.run_id), sessionId: String(row.session_id),
      workspace: String(row.workspace), query: String(row.query), candidateCount: Number(row.candidate_count),
      selected: JSON.parse(String(row.selected)) as MemoryRecallItem[],
      omitted: JSON.parse(String(row.omitted)) as MemoryRecallItem[],
      createdAt: Number(row.created_at)
    }));
  }

  close() { this.db.close(); }

  private reindex(record: MemoryRecord) {
    this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(record.id);
    if (record.status === "deleted") return;
    this.db.prepare("INSERT INTO memory_fts(id,workspace,layer,status,topic,content,terms) VALUES(?,?,?,?,?,?,?)")
      .run(record.id, record.workspace || "", record.layer, record.status || "active", record.topic, record.content, terms(`${record.topic} ${record.content}`).join(" "));
  }
}
