import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryStore,
  factsToMarkdown,
  graphForMemory,
  graphRecallPaths,
  hashEmbedding,
  rankMemories,
  readMemoryFacts,
  selectLifecycle,
  writeMemoryFacts
} from "../src/index.ts";
import type { MemoryRecord, MemoryRecallRecord } from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "nexcore-memory-package-"));
process.once("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch { } });

function add(store: MemoryStore, workspace: string, values: Partial<MemoryRecord> & Pick<MemoryRecord, "topic" | "content">) {
  return store.putMemory({
    layer: "L1", source: "test", confidence: 0.9, importance: 6,
    status: "active", workspace, accessCount: 0, validFrom: Date.now(), ...values
  });
}

test("workspace gate, FTS candidates and graph paths compose", () => {
  const store = new MemoryStore(join(root, "db"));
  const workspace = join(root, "project");
  const other = join(root, "other");
  const record = add(store, workspace, {
    topic: "Canvas rendering decision",
    content: "Use Canvas in game.js without third-party runtime dependencies.",
    layer: "L3", importance: 9, pinned: true
  });
  add(store, other, {
    topic: "Other Canvas decision",
    content: "Use Canvas in game.js for another workspace.",
    layer: "L3", importance: 10
  });
  const graph = graphForMemory(record);
  store.putGraph(record.id, graph.nodes, graph.edges);

  const candidates = store.candidates("Canvas game.js", workspace, 64);
  assert.deepEqual(candidates.map(item => item.item.id), [record.id]);
  const paths = graphRecallPaths("Canvas game.js", store.nodes(workspace), store.edges(workspace), workspace);
  const ranked = rankMemories("Canvas game.js", candidates, paths, 6);
  assert.equal(ranked.selected[0].memoryId, record.id);
  assert.ok(ranked.selected[0].graphPaths.some(path => path.includes("game.js")));
  store.close();
});

test("soft forgetting lowers score without deleting the record", () => {
  const active: MemoryRecord = {
    id: "active", topic: "Constraint", content: "No runtime dependencies.",
    layer: "L1", source: "test", confidence: 1, importance: 9,
    pinned: true, status: "active", createdAt: Date.now(), updatedAt: Date.now()
  };
  const suppressed: MemoryRecord = {
    ...active, id: "suppressed", pinned: false, status: "suppressed",
    content: "Plan to add a runtime dependency."
  };
  const ranked = rankMemories("runtime dependency", [
    { item: active, lexical: 1 },
    { item: suppressed, lexical: 1 }
  ], new Map(), 2);
  assert.ok(ranked.selected[0].score > ranked.selected[1].score);
  assert.ok(ranked.selected.some(item => item.redactedBy === "suppressed"));
  const actions = selectLifecycle([active, suppressed, { ...suppressed, id: "cold", status: "active", pinned: false, useCount: 0 }], 2, 365);
  assert.equal(actions.some(item => item.action === "delete"), false);
  assert.equal(actions.some(item => item.action === "suppress"), true);
});

test("facts.json is the portable source of truth", () => {
  const store = new MemoryStore(join(root, "facts-db"));
  const workspace = join(root, "facts-project");
  const record = add(store, workspace, { topic: "Build output", content: "Artifacts go to dist while source remains.", pinned: true });
  const graph = graphForMemory(record);
  const facts = writeMemoryFacts(workspace, [record], graph.nodes, graph.edges);
  assert.equal(readMemoryFacts(workspace)?.memories[0].id, record.id);
  assert.match(factsToMarkdown(facts), /Build output/);
  store.close();
});

test("recall logs preserve reasons and graph paths", () => {
  const store = new MemoryStore(join(root, "recall-db"));
  const workspace = join(root, "recall-project");
  const record = add(store, workspace, { topic: "Canvas", content: "game.js uses Canvas." });
  const log: MemoryRecallRecord = {
    id: "recall-1", runId: "run-1", sessionId: "session-1", workspace,
    query: "why Canvas", candidateCount: 1,
    selected: [{
      memoryId: record.id, score: 0.8,
      components: { semantic: 1, lexical: 1, graph: 0.5, importance: 0.6, confidence: 0.9, freshness: 1, frequency: 0 },
      reasons: ["pinned"], graphPaths: ["Canvas → applies_to → project"]
    }],
    omitted: [], createdAt: Date.now()
  };
  store.putRecall(log);
  assert.deepEqual(store.recallLogs(workspace)[0].selected, log.selected);
  store.close();
});

test("hash embedding is deterministic", () => {
  assert.deepEqual(hashEmbedding("same project fact"), hashEmbedding("same project fact"));
});
