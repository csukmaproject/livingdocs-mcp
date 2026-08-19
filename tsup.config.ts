import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "core/index": "src/core/index.ts",
    "mcp/server": "src/mcp/server.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ["tree-sitter", "tree-sitter-typescript", "tree-sitter-javascript", "tree-sitter-go", "tree-sitter-python", "tree-sitter-java"],
  onSuccess: async () => {
    // src/templates must stay a sibling of dist/core the same way it's a
    // sibling of src/core, since rollup-engine resolves it relative to itself.
    cpSync("src/templates", "dist/templates", { recursive: true });
  },
});
