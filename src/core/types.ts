// Mirrors livingdocs.config.schema.json — frozen at Phase 1 (APPROVAL GATE 1).

export type EntityType =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "module"
  | "endpoint"
  | "service"
  | "variable"
  | "constant";

export type Confidence = "extracted" | "verified" | "inferred";

export interface ErrorMode {
  errorType: string;
  condition: string;
}

export interface AgentContract {
  signature: string;
  preconditions: string[];
  postconditions: string[];
  sideEffects: string[];
  errorModes: ErrorMode[];
  dependencies: string[];
}

export interface HumanNarrative {
  purpose: string | null;
  rationale: string | null;
  example: string | null;
  gotchas: string[];
}

export interface RevisionEntry {
  commit: string;
  date: string;
  summary: string;
}

export interface DocNode {
  nodeId: string;
  filePath: string;
  entityName: string;
  entityType: EntityType;
  contentHash: string;
  agentContract: AgentContract;
  humanNarrative: HumanNarrative;
  confidence: Record<string, Confidence>;
  revisionHistory: RevisionEntry[];
  tags: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface DocGraph {
  nodes: DocNode[];
  edges: GraphEdge[];
  /**
   * Commit the graph was last generated from. Lets scanRepo diff against
   * committed history since that point, not just the working tree -- a
   * clean `git status` alone can't tell "nothing changed" apart from
   * "the graph predates several already-committed changes".
   */
  lastScannedCommit?: string;
}
