import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

export function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_FILENAME);
}

/** Missing file -> {} (every flag defaults to off), matching the "opt-in" framing -- absence of config must never silently enable a more privileged mode. */
export function loadConfig(repoRoot: string): LivingdocsConfig {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as LivingdocsConfig;
}
