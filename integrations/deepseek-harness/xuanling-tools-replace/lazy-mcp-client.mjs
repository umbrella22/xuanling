const REQUIRED_SERVER_NAME = "xuanling";
const CATALOG_NAME = "mcp_catalog__xuanling";
const MAX_MATCHES = 8;

export const name = "xuanling-lazy-mcp-client";
export const inject = ["tools"];

function bindMember(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === "function" ? value.bind(target) : value;
}

function rawNameFromPublicName(serverName, publicName) {
  // The release contract proves every XuanLing raw name is already valid in
  // DSH's public-name space, so the official bridge performs no lossy rewrite.
  const prefix = `mcp__${serverName}__`;
  if (typeof publicName !== "string" || !publicName.startsWith(prefix)) {
    throw new Error(
      `[XUANLING_LAZY_NAME_MISMATCH] bridge registered ${JSON.stringify(publicName)} outside ${prefix}`,
    );
  }
  const rawName = publicName.slice(prefix.length);
  if (rawName.length === 0 || `${prefix}${rawName}` !== publicName) {
    throw new Error(
      `[XUANLING_LAZY_NAME_MISMATCH] bridge public name is not reversibly qualified: ${publicName}`,
    );
  }
  return rawName;
}

function createCatalogDefinition(state) {
  return {
    name: CATALOG_NAME,
    description:
      "Search cached XuanLing MCP tools by raw name or description and optionally activate one exact raw name for subsequent model turns.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Case-insensitive search text. Empty text lists the first bounded page.",
        },
        activate: {
          type: "string",
          description: "Optional exact raw MCP tool name to activate. Identity matching is case-sensitive.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          total_tools: { type: "integer" },
          matched_tools: { type: "integer" },
          matches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                raw_name: { type: "string" },
                public_name: { type: "string" },
                description: { type: "string" },
                active: { type: "boolean" },
              },
              required: ["raw_name", "public_name", "description", "active"],
              additionalProperties: false,
            },
          },
          active_tools: { type: "array", items: { type: "string" } },
          activated: { type: "string" },
          truncated: { type: "boolean" },
        },
        required: ["query", "total_tools", "matched_tools", "matches", "active_tools", "truncated"],
        additionalProperties: false,
      },
      render(_arguments, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(argumentsValue) {
      if (
        typeof argumentsValue !== "object" ||
        argumentsValue === null ||
        Array.isArray(argumentsValue) ||
        typeof argumentsValue.query !== "string" ||
        (argumentsValue.activate !== undefined && typeof argumentsValue.activate !== "string")
      ) {
        throw new Error("[XUANLING_CATALOG_INVALID_ARGUMENTS] query must be a string and activate must be an optional string");
      }

      let activated;
      if (argumentsValue.activate !== undefined) {
        activated = state.activate(argumentsValue.activate);
      }

      const normalizedQuery = argumentsValue.query.trim().toLocaleLowerCase("en-US");
      const allMatches = [...state.definitions.entries()]
        .map(([rawName, record]) => ({
          raw_name: rawName,
          public_name: record.definition.name,
          description: typeof record.definition.description === "string"
            ? record.definition.description
            : "",
          active: state.isActive(rawName),
        }))
        .filter((entry) =>
          normalizedQuery.length === 0 ||
          entry.raw_name.toLocaleLowerCase("en-US").includes(normalizedQuery) ||
          entry.description.toLocaleLowerCase("en-US").includes(normalizedQuery)
        )
        .sort((left, right) => left.raw_name.localeCompare(right.raw_name, "en-US"));

      return {
        query: argumentsValue.query,
        total_tools: state.definitions.size,
        matched_tools: allMatches.length,
        matches: allMatches.slice(0, MAX_MATCHES),
        active_tools: state.activeRawNames(),
        ...(activated === undefined ? {} : { activated }),
        truncated: allMatches.length > MAX_MATCHES,
      };
    },
  };
}

export async function applyWithOfficialBridge(ctx, config, applyOfficialBridge) {
  if (config?.serverName !== REQUIRED_SERVER_NAME) {
    throw new Error(
      `[XUANLING_LAZY_INVALID_SERVER] expected serverName ${REQUIRED_SERVER_NAME}, got ${JSON.stringify(config?.serverName)}`,
    );
  }
  if (typeof applyOfficialBridge !== "function") {
    throw new Error("[XUANLING_LAZY_INVALID_BRIDGE] official bridge apply export is unavailable");
  }

  const definitions = new Map();
  const desiredActiveNames = new Set();
  const registeredActive = new Map();

  function registerActive(rawName, record) {
    const previous = registeredActive.get(rawName);
    if (previous !== undefined) previous.dispose();
    const dispose = ctx.tools.register(record.definition);
    registeredActive.set(rawName, { record, dispose });
  }

  function captureDefinition(definition) {
    const rawName = rawNameFromPublicName(config.serverName, definition?.name);
    if (definitions.has(rawName)) {
      throw new Error(`[XUANLING_LAZY_DUPLICATE_TOOL] duplicate raw tool name: ${rawName}`);
    }
    const record = { definition };
    definitions.set(rawName, record);
    if (desiredActiveNames.has(rawName)) registerActive(rawName, record);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (definitions.get(rawName) !== record) return;
      definitions.delete(rawName);
      const active = registeredActive.get(rawName);
      if (active?.record === record) {
        active.dispose();
        registeredActive.delete(rawName);
      }
    };
  }

  const projectedTools = new Proxy(ctx.tools, {
    get(target, property) {
      if (property === "register") return captureDefinition;
      return bindMember(target, property);
    },
  });
  const projectedContext = new Proxy(ctx, {
    get(target, property) {
      if (property === "tools") return projectedTools;
      return bindMember(target, property);
    },
  });

  await applyOfficialBridge(projectedContext, { ...config, failOnStartupError: true });
  if (definitions.size === 0) {
    throw new Error("[XUANLING_LAZY_EMPTY_CATALOG] official bridge discovered no XuanLing tools");
  }

  const state = {
    definitions,
    activate(rawName) {
      const record = definitions.get(rawName);
      if (record === undefined) {
        throw new Error(`[XUANLING_CATALOG_UNKNOWN_TOOL] exact raw tool name not found: ${JSON.stringify(rawName)}`);
      }
      if (!desiredActiveNames.has(rawName)) {
        desiredActiveNames.add(rawName);
        try {
          registerActive(rawName, record);
        } catch (error) {
          desiredActiveNames.delete(rawName);
          throw error;
        }
      }
      return rawName;
    },
    isActive(rawName) {
      return registeredActive.has(rawName);
    },
    activeRawNames() {
      return [...registeredActive.keys()].sort((left, right) => left.localeCompare(right, "en-US"));
    },
  };

  ctx.effect(
    () => () => {
      desiredActiveNames.clear();
      for (const active of [...registeredActive.values()].reverse()) active.dispose();
      registeredActive.clear();
    },
    "xuanling.lazy-mcp-active-tools",
  );
  ctx.effect(
    () => ctx.tools.register(createCatalogDefinition(state)),
    "xuanling.lazy-mcp-catalog",
  );
}

export async function apply(ctx, config) {
  const bridge = await import("@deepseek-ai/dsh-mcp-client");
  return applyWithOfficialBridge(ctx, config, bridge.apply);
}
