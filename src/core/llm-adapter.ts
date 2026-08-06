export interface LlmCompletionRequest {
  systemPrompt?: string;
  prompt: string;
  maxTokens?: number;
}

export interface LlmCompletionResult {
  text: string;
}

export interface LlmAdapter {
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

/**
 * Borrows the host agent's own connected model via MCP sampling. The
 * sampling callback is supplied by the MCP server (Phase 4); this class has
 * no MCP SDK dependency itself, so /src/core stays framework-agnostic.
 */
export class SamplingProvider implements LlmAdapter {
  constructor(private readonly sample: (request: LlmCompletionRequest) => Promise<LlmCompletionResult>) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    return this.sample(request);
  }
}

export interface ApiKeyProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Direct API fallback for the CLI/CI path, where there's no MCP host to
 * borrow a model from (docgen-plugin-plan.md Section 4.4). Not invoked
 * anywhere in Phase 2 -- present only as the abstraction later phases wire
 * up, per the brief's "nothing else calls an LLM directly" rule.
 */
export class ApiKeyProvider implements LlmAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: ApiKeyProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "claude-sonnet-5";
    this.baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 1024,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.prompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((block) => block.type === "text")?.text ?? "";
    return { text };
  }
}
