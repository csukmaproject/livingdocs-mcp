#!/usr/bin/env node
/**
 * @purpose MCP stdio server for livingdocs-mcp: exposes the analyze_change, get_contract, update_doc, generate_rollup, get_doc_history, get_status, and bootstrap_repo tools, borrowing the host agent's own model via MCP sampling instead of calling an LLM directly.
 * @audience technical
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  countDocumentableEntities,
  generateDocument,
  loadGraph,
  loadSeed,
  parseDocumentRevisionRows,
  readUserGuide,
  runBootstrap,
  saveSeed,
  scanRepo,
  syncUserGuide,
  SEED_QUESTIONS,
  type BootstrapSeed,
  type LlmCompletionRequest,
  type LlmCompletionResult,
} from "../core/index.js";
import { SamplingProvider } from "../core/llm-adapter.js";

const server = new McpServer({ name: "livingdocs-mcp", version: "1.1.1" });

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

const SECTION_KEYS = ["system-overview", "getting-started", "core-features", "troubleshooting"];

server.registerTool(
  "get_status",
  {
    description:
      "Reports documentation coverage: percentage of documentable entities annotated, which nodes are stale, and the last-sync date per User Guide section. Read-only: does not write the graph or any document. Coverage 0% with zero stale nodes means the repo has never used livingdocs -- call bootstrap_repo next.",
    inputSchema: { repoRoot: repoRootSchema },
  },
  async ({ repoRoot }) => {
    const graph = loadGraph(repoRoot);
    const { changes } = scanRepo(repoRoot, graph);
    const stale = changes.filter((c) => c.classification !== "unchanged");

    const entityNodeCount = graph.nodes.filter((n) => n.entityType !== "module").length;
    const totalDocumentable = countDocumentableEntities(repoRoot);
    const coveragePercent = totalDocumentable === 0 ? 100 : Math.round((entityNodeCount / totalDocumentable) * 100);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              coveragePercent,
              documentedEntities: entityNodeCount,
              totalDocumentableEntities: totalDocumentable,
              staleNodes: stale,
              sectionSyncDates: Object.fromEntries(SECTION_KEYS.map((key) => [key, graph.sectionSyncDates?.[key] ?? "never"])),
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

server.registerTool(
  "bootstrap_repo",
  {
    description:
      "For a repo that has never used livingdocs (0% coverage, no @purpose annotations anywhere): mines code structure, tests, git co-change history, and naming into signals, synthesizes documentation proposals via the connected host's own model (MCP sampling -- no API key needed, works the same whether the host is a CLI-based agentic tool or a desktop agentic app), and writes them into source as INFERRED annotations. " +
      "MUTATES THE REPO: commits to a fresh branch (never the caller's checked-out branch) and, only if `origin` + an authenticated `gh` are both available, pushes and opens a PR. Confirm with the user before calling this tool, the same as any other push/PR-opening action. " +
      "Optional business-context answers sharpen the inferred purpose/rationale; without them, annotations are inferred from code/test/git signals alone. If you want to collect them, ask the user these six questions first, then pass their answers as seedAnswers in the same order: " +
      SEED_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join(" "),
    inputSchema: {
      repoRoot: repoRootSchema,
      seedAnswers: z
        .array(z.string())
        .length(SEED_QUESTIONS.length)
        .optional()
        .describe("Answers to the six seed questions from the tool description, in the same order. Omit to skip (or reuse a previously-saved seed)."),
      resetSeed: z.boolean().optional().describe("If true, ignore any previously-saved seed even when seedAnswers is also omitted."),
    },
  },
  async ({ repoRoot, seedAnswers, resetSeed }) => {
    let seed: BootstrapSeed | null = resetSeed ? null : loadSeed(repoRoot);
    if (seedAnswers) {
      seed = { questions: [...SEED_QUESTIONS], answers: seedAnswers, answeredAt: new Date().toISOString() };
      saveSeed(repoRoot, seed);
    }

    const result = await runBootstrap(repoRoot, { llm: samplingProvider, seed });
    if (result.filesChanged.length === 0) {
      return { content: [{ type: "text", text: "Nothing to bootstrap -- every documentable entity already has a doc comment." }] };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              coverageBefore: result.coverageBefore,
              coverageAfter: result.coverageAfter,
              proposedEntities: result.proposedEntities,
              filesChanged: result.filesChanged,
              branchName: result.branchName,
              pushed: result.pushed,
              prUrl: result.prUrl,
            },
            null,
            2,
          ),
        },
      ],
    };
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
