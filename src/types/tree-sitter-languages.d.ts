declare module "tree-sitter-typescript" {
  const languages: { typescript: unknown; tsx: unknown };
  export = languages;
}

declare module "tree-sitter-javascript" {
  const language: unknown;
  export = language;
}
