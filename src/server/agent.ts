import { config, type LlmProviderId } from "./config.js";
import { logger } from "./logger.js";
import { aggregatedTools, callAggregatedTool } from "./mcpClient.js";
import { estimateCost, type CostEstimate } from "./pricing.js";

/** A chat message exchanged with the frontend (plain text only). */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** A tool call the model requested during a turn. */
interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Internal working transcript entry used during a single agent run. */
type WorkMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** A summarized step surfaced to the UI so users can see what the agent did. */
export interface AgentStep {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  /** Truncated preview of the tool's textual result. */
  preview?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of LLM round-trips made for this message. */
  llmCalls: number;
}

export interface AgentResult {
  reply: string;
  steps: AgentStep[];
  stoppedReason: "completed" | "max_steps";
  model: string;
  provider: LlmProviderId;
  usage: TokenUsage;
  /** List-price cost estimate, or null when the model's price is unknown. */
  cost: CostEstimate | null;
}

interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface LlmCompletion {
  text: string;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

interface LlmProvider {
  id: LlmProviderId;
  complete(
    system: string,
    messages: WorkMessage[],
    tools: LlmTool[],
  ): Promise<LlmCompletion>;
}

const MAX_TOOL_RESULT_CHARS = 12000;

/** Short capability blurb per known Adobe MCP product, keyed by server id. */
const PRODUCT_BLURBS: Record<string, string> = {
  target:
    "Adobe Target (experimentation & personalization): audit A/B/XT/AP activities, review performance & revenue reports, inspect A4T reporting, manage audiences/offers, and prepare QA previews.",
  analytics:
    "Adobe Analytics (web/marketing analytics): discover report suites, dimensions, metrics, calculated metrics and segments, and run ranked/trended reports over date ranges.",
  launch:
    "Adobe Launch / Experience Platform Data Collection (Tags): inspect properties, rules and rule components, data elements, extensions, environments, and libraries/builds; review tag implementation and publishing state.",
};

function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  const labels = config.servers.map((s) => s.label).join(", ");
  const blurbs = config.servers
    .map((s) => PRODUCT_BLURBS[s.id])
    .filter(Boolean)
    .map((b) => `- ${b}`);

  return [
    "You are an expert Adobe Experience Cloud assistant. You work across the connected Adobe products below, using their MCP tools.",
    `Connected products: ${labels || "Adobe Target, Adobe Analytics"}.`,
    ...blurbs,
    "Tools from different products may be namespaced (e.g. analytics__run_report); use whichever tools are available.",
    "",
    "Operating rules:",
    "- ALWAYS call tools to fetch real data before answering. Never invent activity names, IDs, metrics, traffic allocation, revenue, segments, rules, data elements, or statistical results.",
    "- When the user refers to something by name (activity, report suite, segment, audience, metric, Launch property, rule, data element), first list/search the relevant entities to resolve the exact ID, then fetch details.",
    "- If a tool requires an ID you don't yet have, find it with a list/search tool first.",
    "- For Target performance/revenue questions, report status, traffic allocation, how long it has run, key metrics (conversion rate, RPV, orders, revenue), lift vs. control, and statistical significance/confidence when available. Call out the winning experience and any anomalies (sample ratio mismatch, flat/negative lift, low traffic).",
    "- For Analytics questions, identify the report suite, choose appropriate dimensions/metrics/segments and date ranges, and summarize trends, top contributors, and notable changes.",
    "- For Launch / Data Collection questions, identify the property first, then inspect rules, data elements, extensions, environments, and library/build state; explain what fires when and how the implementation is configured.",
    "- When a question spans products (e.g. correlating an experiment with downstream analytics, or checking that a Launch rule fires the Target/Analytics calls), use tools from each as needed and reconcile the data.",
    "- For QA/preview requests, return the preview URLs for each experience.",
    "- If a tool returns an error (e.g. insufficient permissions for your role, or a missing resource), explain what happened and how to resolve it.",
    "",
    "Style: be concise and well-structured. Use short paragraphs, bullet points, and small markdown tables. Lead with the direct answer, then supporting detail.",
    `Today's date is ${today}.`,
  ].join("\n");
}

/** Coerces an MCP tool result into a compact text string for the model. */
function stringifyToolResult(result: unknown): { text: string; isError: boolean } {
  const r = result as
    | { content?: Array<{ type?: string; text?: string }>; isError?: boolean; structuredContent?: unknown }
    | undefined;
  let text = "";
  if (r?.content && Array.isArray(r.content)) {
    text = r.content
      .map((b) => (b?.type === "text" && b.text ? b.text : JSON.stringify(b)))
      .join("\n");
  } else if (r?.structuredContent !== undefined) {
    text = JSON.stringify(r.structuredContent, null, 2);
  } else {
    text = JSON.stringify(result, null, 2);
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
  }
  return { text, isError: Boolean(r?.isError) };
}

function sanitizeSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const clone = { ...(schema as Record<string, unknown>) };
  delete clone.$schema;
  if (!clone.type) clone.type = "object";
  return clone;
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------
class AnthropicProvider implements LlmProvider {
  id: LlmProviderId = "anthropic";

  async complete(
    system: string,
    messages: WorkMessage[],
    tools: LlmTool[],
  ): Promise<LlmCompletion> {
    const anthropicMessages = this.toAnthropicMessages(messages);
    const body = {
      model: config.llm.model,
      max_tokens: config.llm.maxTokens,
      system,
      messages: anthropicMessages,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    };

    const res = await fetch(`${config.llm.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.llm.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API error (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text" && block.text) text += block.text;
      else if (block.type === "tool_use" && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
    const u = data.usage ?? {};
    const inputTokens =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    return {
      text,
      toolCalls,
      usage: { inputTokens, outputTokens: u.output_tokens ?? 0 },
    };
  }

  private toAnthropicMessages(messages: WorkMessage[]): unknown[] {
    const out: Array<{ role: string; content: unknown }> = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        out.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        const content: unknown[] = [];
        if (msg.content) content.push({ type: "text", text: msg.content });
        for (const tc of msg.toolCalls ?? []) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
        out.push({ role: "assistant", content });
      } else {
        // tool result — append into the preceding user turn if it already holds
        // tool_results, otherwise start a new user turn.
        const block = {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.content,
        };
        const last = out[out.length - 1];
        if (
          last &&
          last.role === "user" &&
          Array.isArray(last.content) &&
          (last.content as Array<{ type?: string }>)[0]?.type === "tool_result"
        ) {
          (last.content as unknown[]).push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// OpenAI (and OpenAI-compatible) provider
// ---------------------------------------------------------------------------
class OpenAIProvider implements LlmProvider {
  id: LlmProviderId = "openai";

  async complete(
    system: string,
    messages: WorkMessage[],
    tools: LlmTool[],
  ): Promise<LlmCompletion> {
    const openaiMessages = [
      { role: "system", content: system },
      ...this.toOpenAIMessages(messages),
    ];
    const body = {
      model: config.llm.model,
      max_tokens: config.llm.maxTokens,
      messages: openaiMessages,
      tools: tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      })),
      tool_choice: "auto",
    };

    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${errText}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const message = data.choices?.[0]?.message;
    const text = message?.content ?? "";
    const toolCalls: ToolCall[] = [];
    for (const tc of message?.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = {};
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, input });
    }
    const u = data.usage ?? {};
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
      },
    };
  }

  private toOpenAIMessages(messages: WorkMessage[]): unknown[] {
    return messages.map((msg) => {
      if (msg.role === "user") return { role: "user", content: msg.content };
      if (msg.role === "assistant") {
        return {
          role: "assistant",
          content: msg.content ?? "",
          ...(msg.toolCalls && msg.toolCalls.length
            ? {
                tool_calls: msg.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.input),
                  },
                })),
              }
            : {}),
        };
      }
      return { role: "tool", tool_call_id: msg.toolCallId, content: msg.content };
    });
  }
}

function getProvider(): LlmProvider {
  return config.llm.provider === "openai"
    ? new OpenAIProvider()
    : new AnthropicProvider();
}

/**
 * Pluggable access to the MCP tools. Defaults to the live Adobe Target MCP
 * connection; tests can inject a fake implementation.
 */
export interface AgentDeps {
  getTools(): Promise<
    Array<{ name: string; description: string; inputSchema: unknown }>
  >;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

const defaultDeps: AgentDeps = {
  getTools: () => aggregatedTools(),
  callTool: (name, args) => callAggregatedTool(name, args),
};

/**
 * Runs the agentic loop: feeds the conversation + available MCP tools to the
 * LLM, executes any tool calls against the Adobe Target MCP server, and feeds
 * results back until the model produces a final answer.
 */
export async function runAgent(
  history: ChatMessage[],
  deps: AgentDeps = defaultDeps,
): Promise<AgentResult> {
  if (!config.llm.enabled) {
    throw new Error(
      "The AI assistant is not configured. Set an LLM API key (ANTHROPIC_API_KEY or OPENAI_API_KEY) and restart.",
    );
  }

  const rawTools = await deps.getTools();
  const tools: LlmTool[] = rawTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: sanitizeSchema(t.inputSchema),
  }));

  const provider = getProvider();
  const system = buildSystemPrompt();
  const transcript: WorkMessage[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const steps: AgentStep[] = [];
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    llmCalls: 0,
  };
  const accrue = (c: LlmCompletion) => {
    usage.inputTokens += c.usage.inputTokens;
    usage.outputTokens += c.usage.outputTokens;
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    usage.llmCalls += 1;
  };
  const finalize = (
    reply: string,
    stoppedReason: AgentResult["stoppedReason"],
  ): AgentResult => ({
    reply,
    steps,
    stoppedReason,
    model: config.llm.model,
    provider: config.llm.provider,
    usage,
    cost: estimateCost(config.llm.model, usage.inputTokens, usage.outputTokens),
  });

  for (let i = 0; i < config.llm.maxSteps; i++) {
    const completion = await provider.complete(system, transcript, tools);
    accrue(completion);
    transcript.push({
      role: "assistant",
      content: completion.text || null,
      toolCalls: completion.toolCalls.length ? completion.toolCalls : undefined,
    });

    if (!completion.toolCalls.length) {
      return finalize(completion.text, "completed");
    }

    for (const call of completion.toolCalls) {
      logger.info(`Agent calling tool: ${call.name}`, call.input);
      const step: AgentStep = { name: call.name, args: call.input, ok: false };
      try {
        const result = await deps.callTool(call.name, call.input);
        const { text, isError } = stringifyToolResult(result);
        step.ok = !isError;
        if (isError) step.error = text.slice(0, 400);
        step.preview = text.slice(0, 400);
        transcript.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: text || "(empty result)",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step.ok = false;
        step.error = message;
        transcript.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: `Error calling tool: ${message}`,
        });
      }
      steps.push(step);
    }
  }

  // Hit the step cap — ask for a best-effort final answer without more tools.
  const finalNote =
    "Reached the maximum number of reasoning steps. Summarize what you found so far based on the tool results above; do not call more tools.";
  transcript.push({ role: "user", content: finalNote });
  const finalCompletion = await provider.complete(system, transcript, []);
  accrue(finalCompletion);
  return finalize(
    finalCompletion.text ||
      "I reached the step limit before finishing. Please refine your question or try again.",
    "max_steps",
  );
}
