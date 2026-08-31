#!/usr/bin/env node

import http from "node:http";

import { parseArgs, requiredArg } from "../../npm/scripts/shared.mjs";

const args = parseArgs(process.argv.slice(2));
const expectedVersion = requiredArg(args, "expected-version");
const catalogName = "mcp_catalog__xuanling";
const systemInfoName = "mcp__xuanling__system_info";
const sessionTitleMarker = "Generate the session title from this JSON array of human messages:";
let responseCount = 0;
let xuanlingRequestCount = 0;

function toolNames(body) {
  return (Array.isArray(body.tools) ? body.tools : [])
    .map((tool) => tool?.function?.name)
    .filter((name) => typeof name === "string");
}

function xuanlingToolNames(body) {
  return toolNames(body)
    .filter((name) => name === catalogName || name.startsWith("mcp__xuanling__"))
    .sort();
}

function requireExactNames(actual, expected, stage) {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${stage} XuanLing tool surface mismatch: ${JSON.stringify(actual)}`);
  }
}

function completionChunk(responseId, model, delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-xuanling-${responseId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function sendSse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function toolCallChunks(responseId, model, id, name, argumentsValue) {
  return [
    completionChunk(responseId, model, {
      role: "assistant",
      tool_calls: [{
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(argumentsValue) },
      }],
    }),
    completionChunk(
      responseId,
      model,
      {},
      "tool_calls",
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    ),
  ];
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 5_000_000) throw new Error("request body exceeds fixture limit");
  }
  return JSON.parse(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "xuanling-dsh-verifier", object: "model" }] }));
      return;
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    const body = await readJson(req);
    if (body.stream !== true) throw new Error("DSH verifier requires streaming chat completions");
    const model = typeof body.model === "string" ? body.model : "xuanling-dsh-verifier";
    const responseId = ++responseCount;
    const names = xuanlingToolNames(body);
    const serializedMessages = JSON.stringify(body.messages ?? []);

    if (names.length === 0) {
      if (!serializedMessages.includes(sessionTitleMarker)) {
        throw new Error("request without XuanLing tools was not a recognized session-title request");
      }
      sendSse(res, [
        completionChunk(responseId, model, {
          role: "assistant",
          content: "XuanLing runtime verification",
        }),
        completionChunk(
          responseId,
          model,
          {},
          "stop",
          { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        ),
      ]);
      return;
    }

    xuanlingRequestCount += 1;

    if (xuanlingRequestCount === 1) {
      requireExactNames(names, [catalogName], "initial request");
      sendSse(
        res,
        toolCallChunks(responseId, model, "call_xuanling_catalog", catalogName, {
          query: "system_info",
          activate: "system_info",
        }),
      );
      return;
    }

    if (xuanlingRequestCount === 2) {
      requireExactNames(
        names,
        [catalogName, systemInfoName],
        "post-activation request",
      );
      if (!serializedMessages.includes("system_info") || !serializedMessages.includes("activated")) {
        throw new Error("catalog result did not report the exact system_info activation");
      }
      sendSse(
        res,
        toolCallChunks(responseId, model, "call_xuanling_system_info", systemInfoName, {}),
      );
      return;
    }

    if (xuanlingRequestCount === 3) {
      requireExactNames(
        names,
        [catalogName, systemInfoName],
        "post-tool request",
      );
      if (
        !serializedMessages.includes("xuanling_version") ||
        !serializedMessages.includes(expectedVersion) ||
        !serializedMessages.includes("mcp_contract_version") ||
        !serializedMessages.includes("3")
      ) {
        throw new Error("system_info result did not contain the expected runtime and contract identity");
      }
      sendSse(res, [
        completionChunk(
          responseId,
          model,
          { role: "assistant", content: "DSH lazy XuanLing runtime verified." },
        ),
        completionChunk(
          responseId,
          model,
          {},
          "stop",
          { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        ),
      ]);
      return;
    }

    throw new Error(`unexpected XuanLing model request count: ${xuanlingRequestCount}`);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("mock provider has no TCP address");
  process.stdout.write(`mock-openai: http://127.0.0.1:${address.port}/v1\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
