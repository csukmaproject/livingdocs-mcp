import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DocGraph, DocNode, GraphEdge } from "./types.js";

export const GRAPH_RELATIVE_PATH = ".livingdocs/graph.json";

export function graphPathFor(targetRepoRoot: string): string {
  return join(targetRepoRoot, GRAPH_RELATIVE_PATH);
}

export function loadGraph(targetRepoRoot: string): DocGraph {
  const path = graphPathFor(targetRepoRoot);
  if (!existsSync(path)) {
    return { nodes: [], edges: [] };
  }
  return JSON.parse(readFileSync(path, "utf8")) as DocGraph;
}

export function saveGraph(targetRepoRoot: string, graph: DocGraph): void {
  const path = graphPathFor(targetRepoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

export function getNode(graph: DocGraph, nodeId: string): DocNode | undefined {
  return graph.nodes.find((n) => n.nodeId === nodeId);
}

export function upsertNode(graph: DocGraph, node: DocNode): void {
  const index = graph.nodes.findIndex((n) => n.nodeId === node.nodeId);
  if (index === -1) {
    graph.nodes.push(node);
  } else {
    graph.nodes[index] = node;
  }
}

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
