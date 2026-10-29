export type MemoryLayer = "L1" | "L2" | "L3";
export type MemoryStatus = "active" | "suppressed" | "superseded" | "deleted";
export type MemoryNodeType =
  | "workspace"
  | "session"
  | "agent"
  | "file"
  | "symbol"
  | "tool"
  | "decision"
  | "constraint"
  | "requirement"
  | "artifact"
  | "error"
  | "task";

export type MemoryRecord = {
  id: string;
  topic: string;
  layer: MemoryLayer;
  content: string;
  source: string;
  confidence: number;
  status?: MemoryStatus;
  supersededBy?: string;
  workspace?: string;
  importance?: number;
  pinned?: boolean;
  useCount?: number;
  accessCount?: number;
  lastAccessedAt?: number;
  sourceRunId?: string;
  runId?: string;
  sourceMessageId?: string;
  sourceReceiptId?: string;
  validFrom?: number;
  validTo?: number;
  createdAt: number;
  updatedAt: number;
};

export type MemoryNode = {
  id: string;
  workspace: string;
  type: MemoryNodeType;
  name: string;
  canonicalName: string;
  importance: number;
  lastSeenAt: number;
};

export type MemoryEdge = {
  id: string;
  workspace: string;
  sourceNode: string;
  relation: "applies_to" | "derived_from" | "references" | "modified" | "resolved_by" | "supersedes" | "depends_on";
  targetNode: string;
  confidence: number;
  validFrom: number;
  validTo?: number;
  sourceMemoryId: string;
};

export type MemoryScoreComponents = {
  semantic: number;
  lexical: number;
  graph: number;
  importance: number;
  confidence: number;
  freshness: number;
  frequency: number;
};

export type MemoryRecallItem = {
  memoryId: string;
  score: number;
  components: MemoryScoreComponents;
  reasons: string[];
  graphPaths: string[];
  redactedBy?: "suppressed" | "expired";
};

export type MemoryRecallRecord = {
  id: string;
  runId: string;
  sessionId: string;
  workspace: string;
  query: string;
  candidateCount: number;
  selected: MemoryRecallItem[];
  omitted: MemoryRecallItem[];
  createdAt: number;
};

export type RecallCandidate = {
  item: MemoryRecord;
  lexical: number;
};
