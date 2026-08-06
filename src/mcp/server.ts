#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  applyRegeneration,
  buildEdges,
  getCurrentCommit,
  generateGettingStarted,
  generateSystemOverview,
  loadGraph,
  parseDocumentRevisionRows,
  readPackageMeta,
  readSectionContent,
  replaceSectionContent,
  saveGraph,
  scanRepo,
  seedUserGuide,
  type DocGraph,
  type LlmCompletionRequest,
  type LlmCompletionResult,
} from "../core/index.js";
import { SamplingProvider } from "../core/llm-adapter.js";

const USER_GUIDE_FILENAME = "USER_GUIDE.md";

function userGuidePath(repoRoot: string): string {
  return join(repoRoot, USER_GUIDE_FILENAME);
}

function readUserGuide(repoRoot: string): string {
  const path = userGuidePath(repoRoot);
  if (existsSync(path)) return readFileSync(path, "utf8");
  return seedUserGuide(readPackageMeta(repoRoot));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** undefined (not the sentinel) when there's no real commit to diff against next time. */
function resolveScannedCommit(repoRoot: string): string | undefined {
  const commit = getCurrentCommit(repoRoot);
  return commit === "working-tree" ? undefined : commit;
}

const server = new McpServer({ name: "livingdocs-mcp", version: "0.1.0" });

// Borrows the host agent's own model via MCP sampling -- nothing in this
// server calls an LLM directly outside of this one adapter instance.
const samplingProvider = new SamplingProvider(
  async (request: LlmCompletionRequest): Promise<LlmCompletionResult> => {
    const result = await server.server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: request.prompt } }],
      systemPrompt: request.systemPrompt,
      maxTokens: request.maxTokens ?? 1024,
    });
    const text = result.content.type === "text" ? result.content.text : "";
    return { text };
  },
);
void samplingProvider; // wired up for Phase 8+ generation; unused while only zero-LLM rollups exist.

const repoRootSchema = z.string().describe("Absolute path to the target repo to analyze.");

server.registerTool(
  "analyze_change",
  {
    description:
      "Runs ast-diff + the extractor against the current git diff (falls back to a full scan if the target isn't a git repo). Read-only: does not write the graph or any document.",
    inputSchema: { repoRoot: repoRootSchema },
  },
  async ({ repoRoot }) => {
    const previousGraph = loadGraph(repoRoot);
    const { changes, usedGitScoping } = scanRepo(repoRoot, previousGraph);
    const meaningful = changes.filter((c) => c.classification !== "unchanged");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ usedGitScoping, changes: meaningful }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "get_contract",
  {
    description:
      "Returns the agent-contract facet for one entity, looked up by nodeId (`filePath#entityName:entityType`) or by entityName alone.",
    inputSchema: {
      repoRoot: repoRootSchema,
      nodeId: z.string().optional().describe("Exact nodeId, e.g. src/discounts.ts#normalizeDiscountCode:function"),
      entityName: z.string().optional().describe("Fallback lookup by entity name if nodeId is unknown."),
    },
  },
  async ({ repoRoot, nodeId, entityName }) => {
    const graph = loadGraph(repoRoot);
    const node = nodeId
      ? graph.nodes.find((n) => n.nodeId === nodeId)
      : graph.nodes.find((n) => n.entityName === entityName);

    if (!node) {
      return {
        isError: true,
        content: [{ type: "text", text: `No node found for ${nodeId ?? entityName ?? "(no identifier given)"}` }],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { nodeId: node.nodeId, entityName: node.entityName, entityType: node.entityType, agentContract: node.agentContract },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "update_doc",
  {
    description:
      "Regenerates only the stale nodes/rollups affected by the current git diff, persists the graph, and appends a revision-history entry if anything changed.",
    inputSchema: { repoRoot: repoRootSchema },
  },
  async ({ repoRoot }) => {
    const previousGraph = loadGraph(repoRoot);
    const { currentNodes, changes } = scanRepo(repoRoot, previousGraph);
    const pkg = readPackageMeta(repoRoot);
    const document = readUserGuide(repoRoot);

    const currentGraph: DocGraph = { nodes: currentNodes, edges: buildEdges(currentNodes) };
    const newSystemOverview = generateSystemOverview(currentGraph, pkg);
    const newGettingStarted = generateGettingStarted(pkg);

    let updatedDocument = document;
    const sectionsChanged: string[] = [];
    if (newSystemOverview !== readSectionContent(document, "system-overview")) {
      updatedDocument = replaceSectionContent(updatedDocument, "system-overview", newSystemOverview);
      sectionsChanged.push("system-overview");
    }
    if (newGettingStarted !== readSectionContent(document, "getting-started")) {
      updatedDocument = replaceSectionContent(updatedDocument, "getting-started", newGettingStarted);
      sectionsChanged.push("getting-started");
    }

    const regeneration = applyRegeneration(previousGraph, currentNodes, changes, updatedDocument, getCurrentCommit(repoRoot), today());

    saveGraph(repoRoot, {
      nodes: regeneration.nodes,
      edges: buildEdges(regeneration.nodes),
      lastScannedCommit: resolveScannedCommit(repoRoot),
    });
    writeFileSync(userGuidePath(repoRoot), regeneration.documentMarkdown, "utf8");

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              updated: sectionsChanged.length > 0 || regeneration.addedRevisionRow,
              sectionsChanged,
              revisionRowAdded: regeneration.addedRevisionRow,
              changes: changes.filter((c) => c.classification !== "unchanged"),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "generate_rollup",
  {
    description:
      'Force-generates one named document type from the current graph. Only "user-guide" is implemented so far (Phase 2/8 scope); other types land in Phase 10.',
    inputSchema: { repoRoot: repoRootSchema, type: z.string() },
  },
  async ({ repoRoot, type }) => {
    if (type !== "user-guide") {
      return {
        isError: true,
        content: [
          { type: "text", text: `Document type "${type}" isn't implemented yet -- only "user-guide" exists as of Phase 4.` },
        ],
      };
    }

    const previousGraph = loadGraph(repoRoot);
    const { currentNodes, changes } = scanRepo(repoRoot, previousGraph);
    const pkg = readPackageMeta(repoRoot);
    const currentGraph: DocGraph = { nodes: currentNodes, edges: buildEdges(currentNodes) };

    let document = readUserGuide(repoRoot);
    document = replaceSectionContent(document, "system-overview", generateSystemOverview(currentGraph, pkg));
    document = replaceSectionContent(document, "getting-started", generateGettingStarted(pkg));

    const regeneration = applyRegeneration(previousGraph, currentNodes, changes, document, getCurrentCommit(repoRoot), today());

    saveGraph(repoRoot, {
      nodes: regeneration.nodes,
      edges: buildEdges(regeneration.nodes),
      lastScannedCommit: resolveScannedCommit(repoRoot),
    });
    writeFileSync(userGuidePath(repoRoot), regeneration.documentMarkdown, "utf8");

    return { content: [{ type: "text", text: regeneration.documentMarkdown }] };
  },
);

server.registerTool(
  "get_doc_history",
  {
    description: "Returns revision history for one node (by nodeId) or, if nodeId is omitted, the document-level table.",
    inputSchema: { repoRoot: repoRootSchema, nodeId: z.string().optional() },
  },
  async ({ repoRoot, nodeId }) => {
    if (nodeId) {
      const graph = loadGraph(repoRoot);
      const node = graph.nodes.find((n) => n.nodeId === nodeId);
      if (!node) {
        return { isError: true, content: [{ type: "text", text: `No node found for ${nodeId}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(node.revisionHistory, null, 2) }] };
    }

    const document = readUserGuide(repoRoot);
    return { content: [{ type: "text", text: JSON.stringify(parseDocumentRevisionRows(document), null, 2) }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("livingdocs-mcp fatal error:", error);
  process.exit(1);
});
