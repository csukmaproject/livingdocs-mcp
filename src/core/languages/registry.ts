/**
 * @purpose Central registry of every supported LanguageAdapter, keyed by file extension, so extractor.ts and bootstrap.ts can resolve "which language does this file belong to" without knowing the list of languages themselves.
 * @audience technical
 */
import { extname } from "node:path";
import { typescriptAdapter } from "./typescript.js";
import { goAdapter } from "./go.js";
import { pythonAdapter } from "./python.js";
import { javaAdapter } from "./java.js";
import type { LanguageAdapter } from "./types.js";

export const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [typescriptAdapter, goAdapter, pythonAdapter, javaAdapter];

const EXTENSION_MAP = new Map<string, LanguageAdapter>(
  LANGUAGE_ADAPTERS.flatMap((adapter) => adapter.extensions.map((ext) => [ext, adapter] as const)),
);

/**
 * @purpose Resolves the LanguageAdapter registered for a file's extension.
 * @contract post: returns the adapter whose extensions include filePath's extension, or undefined if no adapter is registered for it.
 *   side-effects: none.
 * @audience technical
 */
export function adapterFor(filePath: string): LanguageAdapter | undefined {
  return EXTENSION_MAP.get(extname(filePath));
}

/**
 * @purpose Checks whether an extension is recognized by any registered adapter.
 * @contract post: returns true iff some adapter's extensions list includes ext.
 *   side-effects: none.
 * @audience technical
 */
export function isSupportedExtension(ext: string): boolean {
  return EXTENSION_MAP.has(ext);
}

/**
 * @purpose Lists every extension recognized by any registered adapter, for user-facing "supported languages" messaging.
 * @contract post: returns the concatenation of every adapter's extensions, in registry order.
 *   side-effects: none.
 * @audience technical
 */
export function allSupportedExtensions(): string[] {
  return LANGUAGE_ADAPTERS.flatMap((adapter) => adapter.extensions);
}

/**
 * @purpose Collects every registered adapter's test-file pattern, for bootstrap's test-reference signal source.
 * @contract post: returns one RegExp per registered adapter, in registry order.
 *   side-effects: none.
 * @audience technical
 */
export function allTestFilePatterns(): RegExp[] {
  return LANGUAGE_ADAPTERS.map((adapter) => adapter.testFilePattern);
}
