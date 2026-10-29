import { createHash } from "node:crypto";
import { terms } from "./graph.ts";
import type { MemoryRecallItem, MemoryScoreComponents, RecallCandidate } from "./types.ts";

const DIMENSIONS = 192;

export function hashEmbedding(value: string, dimensions = DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const term of terms(value)) {
    const digest = createHash("sha256").update(term).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = digest[4] & 1 ? 1 : -1;
    vector[index] += sign * (1 + Math.min(3, term.length / 3));
  }
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / length);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index++) dot += a[index] * b[index];
  return Math.max(-1, Math.min(1, dot));
}

function componentLabels(components: MemoryScoreComponents): string[] {
  const reasons: string[] = [];
  if (components.semantic > 0.08) reasons.push(`semantic ${(components.semantic * 100).toFixed(0)}%`);
  if (components.lexical > 0) reasons.push(`FTS ${(components.lexical * 100).toFixed(0)}%`);
  if (components.graph > 0) reasons.push(`graph ${(components.graph * 100).toFixed(0)}%`);
  if (components.importance >= 0.7) reasons.push("high importance");
  if (components.frequency > 0.1) reasons.push("reused memory");
  return reasons;
}

export type RankedMemories = { selected: MemoryRecallItem[]; omitted: MemoryRecallItem[] };

export function rankMemories(query: string, candidates: RecallCandidate[], graphPaths: Map<string, string[]>, limit = 6, now = Date.now(), lambda = 0.74): RankedMemories {
  const queryVector = hashEmbedding(query);
  const scored = candidates.map(candidate => {
    const item = candidate.item;
    const vector = hashEmbedding(`${item.topic} ${item.content}`);
    const components: MemoryScoreComponents = {
      semantic: Math.max(0, cosine(queryVector, vector)),
      lexical: Math.max(0, Math.min(1, candidate.lexical)),
      graph: Math.min(1, (graphPaths.get(item.id)?.length || 0) / 2),
      importance: Math.max(0, Math.min(1, Number(item.importance ?? 4) / 10)),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
      freshness: 1 / (1 + Math.max(0, now - Number(item.updatedAt || item.createdAt || now)) / 86_400_000 / 180),
      frequency: Math.min(1, Math.log1p(Number(item.accessCount ?? item.useCount) || 0) / Math.log(13))
    };
    let score =
      0.38 * components.semantic +
      0.17 * components.lexical +
      0.15 * components.graph +
      0.12 * components.importance +
      0.08 * components.confidence +
      0.06 * components.freshness +
      0.04 * components.frequency;
    if (item.pinned) score += 0.08;
    if (item.status === "suppressed") score *= 0.35;
    const reasons = componentLabels(components);
    if (item.pinned) reasons.push("pinned");
    if (item.status === "suppressed") reasons.push("soft-forgotten");
    const paths = graphPaths.get(item.id) || [];
    if (paths.length) reasons.push("explainable graph path");
    const memory: MemoryRecallItem = {
      memoryId: item.id,
      score: Number(Math.min(1, score).toFixed(4)),
      components,
      reasons,
      graphPaths: paths,
      ...(item.status === "suppressed" ? { redactedBy: "suppressed" as const } : {})
    };
    return { memory, vector };
  }).sort((a, b) => b.memory.score - a.memory.score);

  const selected: MemoryRecallItem[] = [];
  const remaining = [...scored];
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let best = -Infinity;
    for (let index = 0; index < remaining.length; index++) {
      const redundancy = selected.length
        ? Math.max(...selected.map(item => {
          const source = scored.find(row => row.memory.memoryId === item.memoryId);
          return source ? cosine(remaining[index].vector, source.vector) : 0;
        }))
        : 0;
      const mmr = lambda * remaining[index].memory.score - (1 - lambda) * redundancy;
      if (mmr > best) { best = mmr; bestIndex = index; }
    }
    selected.push(remaining.splice(bestIndex, 1)[0].memory);
  }
  return { selected, omitted: remaining.slice(0, 12).map(item => item.memory) };
}
