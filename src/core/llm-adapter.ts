/**
 * @purpose Defines the LlmAdapter abstraction the rest of /src/core codes against, plus two concrete providers: one that borrows the host MCP agent's own model via sampling, and one that calls the Anthropic API directly with an API key.
 * @audience technical
 */

/**
 * @purpose Input to LlmAdapter.complete: the prompt (and optional system prompt/max tokens) to send to whichever model is behind the adapter.
 * @audience technical
 */
export interface LlmCompletionRequest {
  systemPrompt?: string;
  prompt: string;
  maxTokens?: number;
}

/**
 * @purpose Output of LlmAdapter.complete: the completion text returned by the model.
 * @audience technical
 */
export interface LlmCompletionResult {
  text: string;
}

/**
 * @purpose Abstraction over "ask a model to complete a prompt" that the rest of /src/core depends on instead of any concrete LLM client, so callers don't care whether completions come via MCP sampling or a direct API call.
 * @audience technical
 */
export interface LlmAdapter {
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

/**
 * @purpose Borrows the host agent's own connected model via MCP sampling instead of calling an LLM API directly, so /src/core stays framework-agnostic (the sampling callback is supplied by the MCP server).
 * @contract pre: sample is a callback supplied by the MCP server that performs the actual sampling round-trip.
 *   post: complete() delegates the request verbatim to sample and returns its result.
 *   side-effects: none directly (whatever the injected sample callback does is outside this class's control).
 * @audience technical
 */
export class SamplingProvider implements LlmAdapter {
  constructor(private readonly sample: (request: LlmCompletionRequest) => Promise<LlmCompletionResult>) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    return this.sample(request);
  }
}

/**
 * @purpose Constructor options for ApiKeyProvider: the Anthropic API key plus optional model and base URL overrides.
 * @audience technical
 */
export interface ApiKeyProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

/**
 * @purpose Direct Anthropic API fallback for the CLI/CI path, where there's no MCP host connection to borrow a model from via sampling.
 * @contract pre: options.apiKey is a valid Anthropic API key.
 *   post: complete() posts to `${baseUrl}/v1/messages` with the given prompt/systemPrompt/maxTokens and returns the first text content block from the response (or "" if none).
 *   throws: Error when the Anthropic API responds with a non-ok HTTP status.
 *   side-effects: makes an HTTP request to the Anthropic API.
 * @audience technical
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
