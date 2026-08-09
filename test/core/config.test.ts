import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig } from "../../src/core/config.js";

describe("loadConfig", () => {
  it("defaults to an empty config (autoCommit off) when no config file exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-config-"));
    try {
      expect(loadConfig(tmp)).toEqual({});
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads the opt-in autoCommit flag when present", () => {
    const tmp = mkdtempSync(join(tmpdir(), "livingdocs-config-"));
    try {
      writeFileSync(configPath(tmp), JSON.stringify({ ci: { autoCommit: true } }));
      expect(loadConfig(tmp)).toEqual({ ci: { autoCommit: true } });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
