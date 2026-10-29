import { createHash } from "node:crypto";
import type { MemoryEdge, MemoryNode, MemoryNodeType, MemoryRecord } from "./types.ts";

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function terms(value: string): string[] {
  const parts = value.toLowerCase().normalize("NFKC").match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) || [];
  return parts.flatMap(part => /\p{Script=Han}/u.test(part) && part.length > 1
    ? Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2))
    : [part]);
}

export function memoryNodeType(topic: string, content: string): MemoryNodeType {
  if (/约束|必须|禁止|不得|不能|仅可/.test(`${topic} ${content}`)) return "constraint";
  if (/决策|决定|采用|选择|方案/.test(`${topic} ${content}`)) return "decision";
  if (/需求|验收|目标|要求/.test(`${topic} ${content}`)) return "requirement";
  if (/错误|失败|异常|报错/.test(`${topic} ${content}`)) return "error";
  if (/任务|待办|续跑/.test(`${topic} ${content}`)) return "task";
  if (/(?:[\w\u4e00-\u9fa5.-]+\/)+[\w\u4e00-\u9fa5.-]+\.[a-z0-9]{1,6}\b/i.test(content)) return "artifact";
  return "decision";
}

function nodeId(workspace: string, type: MemoryNodeType, name: string): string {
  return "node:" + createHash("sha256").update(`${workspace}\0${type}\0${normalize(name)}`).digest("hex").slice(0, 24);
}

const FILE_IN_TEXT = /(?:[\w\u4e00-\u9fa5.-]+\/)+[\w\u4e00-\u9fa5.-]+\.[a-z0-9]{1,6}\b|\b[\w-]+\.(?:md|txt|json|log|ts|tsx|js|mjs|py|html|csv|xlsx|pdf|png)\b/gi;

export function graphForMemory(record: MemoryRecord, now = Date.now()): { nodes: MemoryNode[]; edges: MemoryEdge[] } {
  const workspace = record.workspace || "";
  if (!workspace) return { nodes: [], edges: [] };
  const nodes = new Map<string, MemoryNode>();
  const edges: MemoryEdge[] = [];
  const primaryType = memoryNodeType(record.topic, record.content);
  const primary: MemoryNode = {
    id: nodeId(workspace, primaryType, record.topic),
    workspace, type: primaryType, name: record.topic,
    canonicalName: normalize(record.topic), importance: Number(record.importance) || 4, lastSeenAt: now
  };
  nodes.set(primary.id, primary);
  const workspaceNode: MemoryNode = {
    id: nodeId(workspace, "workspace", workspace), workspace, type: "workspace",
    name: workspace, canonicalName: normalize(workspace), importance: 10, lastSeenAt: now
  };
  nodes.set(workspaceNode.id, workspaceNode);
  const addEdge = (sourceNode: string, relation: MemoryEdge["relation"], targetNode: string, confidence = 1) => {
    const id = "edge:" + createHash("sha256").update(`${record.id}\0${sourceNode}\0${relation}\0${targetNode}`).digest("hex").slice(0, 24);
    edges.push({ id, workspace, sourceNode, relation, targetNode, confidence, validFrom: Number(record.validFrom) || now, sourceMemoryId: record.id });
  };
  addEdge(primary.id, "applies_to", workspaceNode.id);
  if (record.sourceRunId || record.runId) {
    const runId = String(record.sourceRunId || record.runId);
    const runNode: MemoryNode = {
      id: nodeId(workspace, "session", runId), workspace, type: "session", name: runId,
      canonicalName: normalize(runId), importance: 5, lastSeenAt: now
    };
    nodes.set(runNode.id, runNode);
    addEdge(primary.id, "derived_from", runNode.id);
  }
  for (const match of record.content.matchAll(FILE_IN_TEXT)) {
    const name = match[0];
    const type: MemoryNodeType = /\.[a-z0-9]{1,6}$/i.test(name) ? "file" : "artifact";
    const fileNode: MemoryNode = {
      id: nodeId(workspace, type, name), workspace, type, name,
      canonicalName: normalize(name), importance: 6, lastSeenAt: now
    };
    nodes.set(fileNode.id, fileNode);
    addEdge(primary.id, "references", fileNode.id, Number(record.confidence) || 0.6);
  }
  return { nodes: [...nodes.values()], edges };
}

export function graphRecallPaths(query: string, nodes: MemoryNode[], edges: MemoryEdge[], workspace: string): Map<string, string[]> {
  const queryTerms = new Set(terms(query));
  if (!queryTerms.size) return new Map();
  const adjacency = new Map<string, { node: string; edge: MemoryEdge }[]>();
  for (const edge of edges) {
    if (edge.workspace !== workspace || (edge.validTo && edge.validTo < Date.now())) continue;
    for (const [from, to] of [[edge.sourceNode, edge.targetNode], [edge.targetNode, edge.sourceNode]]) {
      const list = adjacency.get(from) || [];
      list.push({ node: to, edge });
      adjacency.set(from, list);
    }
  }
  const seeds = nodes.filter(node => node.workspace === workspace && terms(`${node.name} ${node.canonicalName}`).some(term => queryTerms.has(term)));
  const names = new Map(nodes.map(node => [node.id, node.name]));
  const paths = new Map<string, string[]>();
  for (const seed of seeds.slice(0, 20)) {
    const queue = [{ id: seed.id, labels: [seed.name], depth: 0 }];
    const seen = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      if (seen.has(current.id) || current.depth > 2) continue;
      seen.add(current.id);
      for (const next of adjacency.get(current.id) || []) {
        const labels = [...current.labels, next.edge.relation, names.get(next.node) || next.node];
        if (next.edge.sourceMemoryId) {
          const list = paths.get(next.edge.sourceMemoryId) || [];
          if (list.length < 3) list.push(labels.join(" → "));
          paths.set(next.edge.sourceMemoryId, list);
        }
        queue.push({ id: next.node, labels, depth: current.depth + 1 });
      }
    }
  }
  return paths;
}
