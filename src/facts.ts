import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEdge, MemoryNode, MemoryRecord } from "./types.ts";

export type MemoryFacts = {
  version: 1;
  updatedAt: number;
  workspace?: string;
  memories: MemoryRecord[];
  nodes: MemoryNode[];
  edges: MemoryEdge[];
};

export function projectMemoryDir(workspace: string): string {
  return join(workspace, ".NexcoreWork");
}

export function readMemoryFacts(workspace: string): MemoryFacts | null {
  try {
    const parsed = JSON.parse(readFileSync(join(projectMemoryDir(workspace), "facts.json"), "utf8")) as Partial<MemoryFacts>;
    if (parsed.version !== 1 || !Array.isArray(parsed.memories) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return {
      version: 1,
      updatedAt: Number(parsed.updatedAt) || 0,
      workspace: typeof parsed.workspace === "string" ? parsed.workspace : workspace,
      memories: parsed.memories,
      nodes: parsed.nodes,
      edges: parsed.edges
    };
  } catch { return null; }
}

export function writeMemoryFacts(workspace: string, memories: MemoryRecord[], nodes: MemoryNode[], edges: MemoryEdge[]): MemoryFacts {
  const dir = projectMemoryDir(workspace);
  mkdirSync(dir, { recursive: true });
  const value: MemoryFacts = { version: 1, updatedAt: Date.now(), workspace, memories, nodes, edges };
  const target = join(dir, "facts.json");
  const temporary = target + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  renameSync(temporary, target);
  return value;
}

export function factsToMarkdown(facts: MemoryFacts): string {
  const labels = { L3: "Core decisions and constraints", L2: "Project experience", L1: "Facts and preferences" };
  const lines = ["# NexcoreWork project memory", "", `> Updated ${new Date(facts.updatedAt).toISOString()}`, ""];
  for (const layer of ["L3", "L2", "L1"] as const) {
    const records = facts.memories.filter(item => item.layer === layer && item.status !== "deleted" && item.status !== "superseded");
    if (!records.length) continue;
    lines.push(`## ${labels[layer]}`, "");
    for (const record of records) lines.push(`- **${record.topic}** — ${record.content}${record.pinned ? " *(pinned)*" : record.status === "suppressed" ? " *(soft-forgotten)*" : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}
