/**
 * @purpose Loads the optional livingdocs.config.json file from the repo root, defaulting every flag to off when the file is absent.
 * @audience technical
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @purpose Shape of livingdocs.config.json: currently just the CI section controlling whether doc updates may be auto-committed on the PR branch.
 * @audience technical
 */
export interface LivingdocsConfig {
  ci?: {
    /**
     * Opt-in: commit doc updates directly on the PR branch in CI instead
     * of the default trust level (post a PR comment, no direct commit) --
     * build brief Phase 11.
     */
    autoCommit?: boolean;
  };
}

const CONFIG_FILENAME = "livingdocs.config.json";

/**
 * @purpose Builds the absolute path to the repo's livingdocs.config.json file.
 * @contract pre: repoRoot is an absolute path to the repo root.
 *   post: returns repoRoot joined with "livingdocs.config.json".
 *   side-effects: none.
 * @audience technical
 */
export function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_FILENAME);
}

/**
 * @purpose Loads livingdocs.config.json from the repo root, defaulting to {} (every flag off) when the file doesn't exist, so absence of config can never silently enable a more privileged mode.
 * @contract post: returns the parsed config when livingdocs.config.json exists, else {}.
 *   throws: SyntaxError when the config file exists but contains invalid JSON.
 *   side-effects: reads the filesystem (existsSync/readFileSync); no writes.
 * @audience technical
 */
export function loadConfig(repoRoot: string): LivingdocsConfig {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as LivingdocsConfig;
}
