#!/usr/bin/env node
/**
 * @purpose MCP stdio server for livingdocs-mcp: exposes the analyze_change, get_contract, update_doc, generate_rollup, and get_doc_history tools, borrowing the host agent's own model via MCP sampling instead of calling an LLM directly.
 * @audience technical
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  generateDocument,
  loadGraph,
  parseDocumentRevisionRows,
  readUserGuide,
  scanRepo,
  syncUserGuide,
  type LlmCompletionRequest,
  type LlmCompletionResult,
} from "../core/index.js";
import { SamplingProvider } from "../core/llm-adapter.js";

const server = new McpServer({ name: "livingdocs-mcp", version: "1.0.0" });

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
      content: [{ type: "text", text: JSON.stringify({ usedGitScoping, changes: meaningful }, null, 2) }],
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
    const result = await syncUserGuide(repoRoot, { llm: samplingProvider });
    const meaningfulChanges = result.changes.filter((c) => c.classification !== "unchanged");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              updated: result.sectionsChanged.length > 0 || result.revisionRowAdded,
              sectionsChanged: result.sectionsChanged,
              revisionRowAdded: result.revisionRowAdded,
              changes: meaningfulChanges,
              crossCheck: result.crossCheck,
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
      "Force-generates one named document type from the current graph: user-guide, agent-contract-reference, srs, prd, technical-guide, or business-guide.",
    inputSchema: { repoRoot: repoRootSchema, type: z.string() },
  },
  async ({ repoRoot, type }) => {
    const result = await generateDocument(repoRoot, type, samplingProvider);
    if (!result.ok) {
      return { isError: true, content: [{ type: "text", text: result.error }] };
    }
    const hasCrossCheckIssues =
      result.crossCheck && (result.crossCheck.missingFromTroubleshooting.length > 0 || result.crossCheck.orphanedInTroubleshooting.length > 0);
    return {
      content: [{ type: "text", text: result.content }],
      ...(hasCrossCheckIssues ? { _meta: { crossCheck: result.crossCheck } } : {}),
    };
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

/**
 * @purpose Boots the MCP server by connecting it to a stdio transport, the standard entry point for an MCP stdio server process.
 * @contract post: creates a StdioServerTransport and connects `server` to it; resolves once the connection is established.
 *   side-effects: opens the process's stdio streams as the MCP transport.
 * @audience technical
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error("livingdocs-mcp fatal error:", error);
  process.exit(1);
});
