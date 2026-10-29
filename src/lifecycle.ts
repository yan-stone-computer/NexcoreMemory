import type { MemoryRecord } from "./types.ts";

export type LifecycleAction = {
  id: string;
  action: "delete" | "suppress";
  reason: string;
};

/** TTL expiry is physical; capacity pressure becomes soft forgetting and never deletes pinned records. */
export function selectLifecycle(records: MemoryRecord[], max: number, ttlDays: number, now = Date.now()): LifecycleAction[] {
  const actions: LifecycleAction[] = [];
  const alive = records.filter(item => {
    if (!item.pinned && item.status !== "deleted" && item.status !== "superseded" && now - Number(item.createdAt) > ttlDays * 86_400_000) {
      actions.push({ id: item.id, action: "delete", reason: `expired after ${ttlDays} days` });
      return false;
    }
    return true;
  });
  if (alive.length > max) {
    const candidates = alive
      .filter(item => !item.pinned && item.status !== "suppressed" && item.status !== "deleted" && item.status !== "superseded")
      .sort((a, b) => (Number(a.useCount) || 0) - (Number(b.useCount) || 0) || Number(a.updatedAt) - Number(b.updatedAt));
    for (const item of candidates.slice(0, Math.max(0, alive.length - max))) {
      actions.push({ id: item.id, action: "suppress", reason: `over capacity ${max}; lowered recall probability` });
    }
  }
  return actions;
}
