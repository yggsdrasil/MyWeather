// Integration test for the agent loop. Spins up a fake LLM endpoint that
// emulates the Anthropic / OpenAI tool-calling APIs, injects a fake MCP tool
// executor, and verifies runAgent() performs the tool call and summarizes.
//
// Usage: node scripts/agent-itest.mjs [anthropic|openai]
// (run after `npm run build`).

import http from "node:http";

const provider = process.argv[2] === "openai" ? "openai" : "anthropic";
const PORT = 8731;

// --- Configure env BEFORE importing the compiled config/agent modules. ---
process.env.LLM_PROVIDER = provider;
process.env.LLM_API_KEY = "test-key";
process.env.LLM_MODEL = "test-model";
if (provider === "anthropic") {
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${PORT}/v1`;
} else {
  process.env.OPENAI_BASE_URL = `http://localhost:${PORT}/v1`;
}

const FINAL_TEXT =
  "Found 1 active test: Homepage Hero (AT100), 50/50 traffic split, running 12 days.";

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data ? JSON.parse(data) : {}));
  });
}

const server = http.createServer(async (req, res) => {
  const body = await readBody(req);
  res.setHeader("content-type", "application/json");

  if (req.url.endsWith("/messages")) {
    // Anthropic: second turn if a tool_result is present.
    const hasToolResult = (body.messages || []).some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result"),
    );
    if (hasToolResult) {
      res.end(
        JSON.stringify({
          content: [{ type: "text", text: FINAL_TEXT }],
          stop_reason: "end_turn",
        }),
      );
    } else {
      res.end(
        JSON.stringify({
          content: [
            { type: "text", text: "Let me check active activities." },
            {
              type: "tool_use",
              id: "tu1",
              name: "list_target_activities",
              input: { state: "activated" },
            },
          ],
          stop_reason: "tool_use",
        }),
      );
    }
    return;
  }

  if (req.url.endsWith("/chat/completions")) {
    // OpenAI: second turn if a tool-role message is present.
    const hasToolResult = (body.messages || []).some((m) => m.role === "tool");
    if (hasToolResult) {
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: FINAL_TEXT } }],
        }),
      );
    } else {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tc1",
                    type: "function",
                    function: {
                      name: "list_target_activities",
                      arguments: JSON.stringify({ state: "activated" }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
    }
    return;
  }

  res.statusCode = 404;
  res.end("{}");
});

const fakeDeps = {
  async getTools() {
    return [
      {
        name: "list_target_activities",
        description: "List Adobe Target activities, optionally filtered by state.",
        inputSchema: {
          type: "object",
          properties: { state: { type: "string" } },
        },
      },
    ];
  },
  async callTool(name, args) {
    if (name !== "list_target_activities") {
      throw new Error(`Unexpected tool: ${name}`);
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            requestedState: args.state,
            activities: [
              {
                id: "AT100",
                name: "Homepage Hero",
                state: "activated",
                trafficAllocation: "50/50",
                daysRunning: 12,
              },
            ],
          }),
        },
      ],
      isError: false,
    };
  },
};

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

await new Promise((resolve) => server.listen(PORT, resolve));

try {
  const { runAgent } = await import("../dist/server/agent.js");
  const { config } = await import("../dist/server/config.js");

  console.log(`\n[${provider}] agent integration test`);
  assert(config.llm.enabled, "LLM is enabled from env");
  assert(config.llm.provider === provider, `provider resolved to ${provider}`);

  const result = await runAgent(
    [{ role: "user", content: "What A/B tests are currently active?" }],
    fakeDeps,
  );

  assert(result.steps.length === 1, "exactly one tool call was made");
  assert(
    result.steps[0].name === "list_target_activities",
    "called list_target_activities",
  );
  assert(result.steps[0].ok === true, "tool call reported success");
  assert(
    JSON.stringify(result.steps[0].args) === JSON.stringify({ state: "activated" }),
    "tool args were passed through correctly",
  );
  assert(result.stoppedReason === "completed", "loop completed normally");
  assert(
    result.reply.includes("Homepage Hero"),
    "final reply summarizes real tool data",
  );

  console.log(`[${provider}] PASSED\n`);
} finally {
  server.close();
}
