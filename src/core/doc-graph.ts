/**
 * @purpose Persists and loads the on-disk doc graph (.livingdocs/graph.json) and provides node lookup/upsert and dependency-edge construction over it.
 * @audience technical
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DocGraph, DocNode, GraphEdge } from "./types.js";

export const GRAPH_RELATIVE_PATH = ".livingdocs/graph.json";

/**
 * @purpose Resolves the absolute path to the graph file for a given target repo.
 * @contract pre: none.
 *   post: returns targetRepoRoot joined with GRAPH_RELATIVE_PATH.
 *   side-effects: none.
 * @audience technical
 */
export function graphPathFor(targetRepoRoot: string): string {
  return join(targetRepoRoot, GRAPH_RELATIVE_PATH);
}

/**
 * @purpose Loads the persisted doc graph for a repo, or an empty graph when none exists yet.
 * @contract pre: none.
 *   post: returns the parsed JSON contents of the graph file at graphPathFor(targetRepoRoot); returns { nodes: [], edges: [] } when the file doesn't exist.
 *   throws: SyntaxError when the file exists but contains invalid JSON.
 *   side-effects: reads from the filesystem.
 * @audience technical
 */
export function loadGraph(targetRepoRoot: string): DocGraph {
  const path = graphPathFor(targetRepoRoot);
  if (!existsSync(path)) {
    return { nodes: [], edges: [] };
  }
  return JSON.parse(readFileSync(path, "utf8")) as DocGraph;
}

/**
 * @purpose Writes the doc graph to disk, creating its parent directory if needed.
 * @contract pre: none.
 *   post: serializes graph as pretty-printed JSON plus a trailing newline to graphPathFor(targetRepoRoot).
 *   side-effects: creates the .livingdocs directory if it doesn't exist, and writes/overwrites the graph file.
 * @audience technical
 */
export function saveGraph(targetRepoRoot: string, graph: DocGraph): void {
  const path = graphPathFor(targetRepoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

/**
 * @purpose Finds a single node in a graph by its node ID.
 * @contract pre: none.
 *   post: returns the first node whose nodeId matches, or undefined when none match.
 *   side-effects: none.
 * @audience technical
 */
export function getNode(graph: DocGraph, nodeId: string): DocNode | undefined {
  return graph.nodes.find((n) => n.nodeId === nodeId);
}

/**
 * @purpose Inserts a new node into a graph or replaces the existing node with the same ID, keeping node IDs unique.
 * @contract pre: none.
 *   post: appends node to graph.nodes when no existing node shares its nodeId, otherwise replaces the matching entry in place.
 *   side-effects: mutates the graph object passed in.
 * @audience technical
 */
export function upsertNode(graph: DocGraph, node: DocNode): void {
  const index = graph.nodes.findIndex((n) => n.nodeId === node.nodeId);
  if (index === -1) {
    graph.nodes.push(node);
  } else {
    graph.nodes[index] = node;
  }
}

/**
 * @purpose Derives graph edges from each node's declared dependencies, linking a node to another only when that dependency is itself present in the given node set.
 * @contract pre: none.
 *   post: returns one edge {from, to} per dependency of each node whose target nodeId is present among nodes; dependencies pointing outside the given node set are silently omitted.
 *   side-effects: none.
 * @audience technical
 */
export function buildEdges(nodes: DocNode[]): GraphEdge[] {
  const nodeIds = new Set(nodes.map((n) => n.nodeId));
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.agentContract.dependencies) {
      if (nodeIds.has(dep)) {
        edges.push({ from: node.nodeId, to: dep });
      }
    }
  }
  return edges;
}
