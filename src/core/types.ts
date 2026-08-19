/**
 * @purpose Defines the DocNode/AgentContract/HumanNarrative/DocGraph shapes that mirror livingdocs.config.schema.json, forming the shared data model the extractor produces and the rest of the pipeline consumes.
 * @audience technical
 */

// Mirrors livingdocs.config.schema.json — frozen at Phase 1 (APPROVAL GATE 1).

/**
 * @purpose Enumerates the kinds of code entity a DocNode can represent, matching the entity categories the extractor and schema recognize.
 * @audience technical
 */
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
  | "constant"
  | "struct"
  | "enum";

/**
 * @purpose Labels how a DocNode field's value was obtained: parsed straight from an annotation comment, confirmed by a human, or inferred without a source annotation.
 * @audience technical
 */
export type Confidence = "extracted" | "verified" | "inferred";

/**
 * @purpose Represents one `throws: <ErrorType> when <condition>` clause parsed out of an @contract tag.
 * @audience technical
 */
export interface ErrorMode {
  errorType: string;
  condition: string;
}

/**
 * @purpose Holds the machine-readable contract extracted from an entity's @contract tag: its signature plus preconditions, postconditions, side effects, error modes, and dependencies.
 * @audience technical
 */
export interface AgentContract {
  signature: string;
  preconditions: string[];
  postconditions: string[];
  sideEffects: string[];
  errorModes: ErrorMode[];
  dependencies: string[];
}

/**
 * @purpose Holds the human-facing narrative for an entity -- its stated purpose plus rationale/example/gotchas fields reserved for future annotation tags not yet parsed by the extractor.
 * @audience technical
 */
export interface HumanNarrative {
  purpose: string | null;
  rationale: string | null;
  example: string | null;
  gotchas: string[];
}

/**
 * @purpose Records one historical change to a DocNode -- which commit touched it, when, and a summary -- for a node's revisionHistory log.
 * @audience technical
 */
export interface RevisionEntry {
  commit: string;
  date: string;
  summary: string;
}

/**
 * @purpose The unit of documentation the whole pipeline works with: one annotated code entity, its identity, extracted contract and narrative, per-field confidence, revision history, and tags.
 * @audience technical
 */
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

/**
 * @purpose Represents a directed relationship between two DocNodes, identified by their nodeIds.
 * @audience technical
 */
export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * @purpose The full extracted documentation graph for a repo: all DocNodes, the edges between them, and bookkeeping (last-scanned commit, section sync dates, cached error resolutions) used to avoid redundant regeneration.
 * @audience technical
 */
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
  /** sectionKey -> ISO date the section's rendered text last actually changed. Read by `livingdocs status`. */
  sectionSyncDates?: Record<string, string>;
  /** errorType -> previously-generated suggested-resolution sentence, carried forward so unchanged error types don't get re-sent to the model every regen. */
  errorResolutions?: Record<string, string>;
}
