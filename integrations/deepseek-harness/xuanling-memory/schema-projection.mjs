const ANNOTATION_KEYWORDS = new Set(["description", "title", "default", "examples"]);
const SUPPORTED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const KNOWN_KEYWORDS = new Set([
  "$schema",
  "$defs",
  "$ref",
  "type",
  "oneOf",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  ...ANNOTATION_KEYWORDS,
  "format",
  "minimum",
]);

export class DshSchemaProjectionError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "DshSchemaProjectionError";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectionError(path, message) {
  throw new DshSchemaProjectionError(path, message);
}

function cloneJson(value) {
  return structuredClone(value);
}

function annotations(node, path) {
  const projected = {};
  for (const key of ANNOTATION_KEYWORDS) {
    if (!Object.hasOwn(node, key)) continue;
    if ((key === "description" || key === "title") && typeof node[key] !== "string") {
      projectionError(`${path}.${key}`, "must be a string");
    }
    projected[key] = cloneJson(node[key]);
  }
  return projected;
}

function resolveLocalRef(root, ref, path) {
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
    projectionError(path, `only local #/$defs references are supported, received ${JSON.stringify(ref)}`);
  }
  let current = root;
  for (const encodedSegment of ref.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      projectionError(path, `dangling reference ${JSON.stringify(ref)}`);
    }
    current = current[segment];
  }
  if (!isRecord(current)) {
    projectionError(path, `reference ${JSON.stringify(ref)} does not resolve to a schema object`);
  }
  return current;
}

function mergeProjectedRef(target, siblingAnnotations, path) {
  const merged = cloneJson(target);
  for (const [key, value] of Object.entries(siblingAnnotations)) {
    if (Object.hasOwn(merged, key) && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
      projectionError(path, `reference sibling ${JSON.stringify(key)} conflicts with its target`);
    }
    merged[key] = value;
  }
  return merged;
}

function possibleTypes(schema) {
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.oneOf)) {
    const result = new Set();
    for (const branch of schema.oneOf) {
      for (const type of possibleTypes(branch)) result.add(type);
    }
    return result;
  }
  return new Set();
}

function assertBranchesDisjoint(branches, path) {
  for (let left = 0; left < branches.length; left += 1) {
    const leftTypes = possibleTypes(branches[left]);
    if (leftTypes.size === 0) {
      projectionError(`${path}[${left}]`, "cannot prove this anyOf branch is disjoint");
    }
    for (let right = left + 1; right < branches.length; right += 1) {
      const rightTypes = possibleTypes(branches[right]);
      if ([...leftTypes].some((type) => rightTypes.has(type))) {
        projectionError(path, "anyOf branches overlap by JSON type and cannot be projected to oneOf");
      }
    }
  }
}

function appendCanonicalConstraints(projected, node, path) {
  const constraints = [];
  if (Object.hasOwn(node, "format")) {
    if (typeof node.format !== "string" || node.format.length === 0) {
      projectionError(`${path}.format`, "must be a non-empty string");
    }
    constraints.push(`format=${node.format}`);
  }
  if (Object.hasOwn(node, "minimum")) {
    if (typeof node.minimum !== "number" || !Number.isFinite(node.minimum)) {
      projectionError(`${path}.minimum`, "must be a finite number");
    }
    if (node.type !== "number" && node.type !== "integer") {
      projectionError(`${path}.minimum`, "is only supported on numeric schemas");
    }
    constraints.push(`minimum=${JSON.stringify(node.minimum)}`);
  }
  if (constraints.length === 0) return;
  const note = `Canonical constraints enforced by XuanLing: ${constraints.join(", ")}.`;
  projected.description = projected.description ? `${projected.description}\n${note}` : note;
}

function appendDescription(projected, note) {
  projected.description = projected.description ? `${projected.description}\n${note}` : note;
}

function flattenTaggedObjectUnion(branches, parentAnnotations) {
  const branchKeys = new Set(["type", "properties", "required", "additionalProperties"]);
  if (
    !branches.every(
      (branch) =>
        branch.type === "object" &&
        isRecord(branch.properties) &&
        Object.keys(branch).every((key) => branchKeys.has(key)),
    )
  ) {
    return undefined;
  }

  const variants = [];
  for (const branch of branches) {
    const discriminator = branch.properties.type;
    if (
      !isRecord(discriminator) ||
      discriminator.type !== "string" ||
      typeof discriminator.const !== "string" ||
      !Array.isArray(branch.required) ||
      !branch.required.includes("type")
    ) {
      return undefined;
    }
    variants.push({ tag: discriminator.const, branch, required: new Set(branch.required) });
  }
  if (new Set(variants.map((variant) => variant.tag)).size !== variants.length) return undefined;

  const properties = {
    type: {
      type: "string",
      enum: variants.map((variant) => variant.tag),
      description: "Tagged-object variant discriminator.",
    },
  };
  for (const { branch } of variants) {
    for (const [name, schema] of Object.entries(branch.properties)) {
      if (name === "type") continue;
      if (Object.hasOwn(properties, name) && JSON.stringify(properties[name]) !== JSON.stringify(schema)) {
        return undefined;
      }
      properties[name] = cloneJson(schema);
    }
  }

  const requiredByEveryVariant = [...variants[0].required].filter((name) =>
    variants.every((variant) => variant.required.has(name)),
  );
  for (const [name, schema] of Object.entries(properties)) {
    if (name === "type" || requiredByEveryVariant.includes(name)) continue;
    const requiredTags = variants
      .filter((variant) => variant.required.has(name))
      .map((variant) => JSON.stringify(variant.tag));
    if (requiredTags.length > 0) {
      appendDescription(schema, `Required when type is ${requiredTags.join(" or ")}.`);
    }
  }

  const projected = {
    ...parentAnnotations,
    type: "object",
    properties,
    required: requiredByEveryVariant,
  };
  if (branches.every((branch) => branch.additionalProperties === false)) {
    projected.additionalProperties = false;
  }
  appendDescription(
    projected,
    `Tagged-object variants: ${variants
      .map((variant) => {
        const conditional = [...variant.required].filter((name) => name !== "type");
        return conditional.length === 0
          ? `type=${JSON.stringify(variant.tag)}`
          : `type=${JSON.stringify(variant.tag)} requires ${conditional.join(", ")}`;
      })
      .join("; ")}.`,
  );
  return projected;
}

function assertOnly(node, allowed, path) {
  for (const key of Object.keys(node)) {
    if (allowed.has(key) || key === "$schema" || key === "$defs") continue;
    projectionError(`${path}.${key}`, "is not valid for this schema form");
  }
}

function projectNode(node, root, path, refStack, depth) {
  if (depth > 64) projectionError(path, "schema nesting exceeds 64 levels");
  if (!isRecord(node)) projectionError(path, "must be a schema object");

  for (const key of Object.keys(node)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      projectionError(`${path}.${key}`, "is not supported by the DSH schema projection");
    }
  }

  if (Object.hasOwn(node, "$ref")) {
    assertOnly(node, new Set(["$ref", ...ANNOTATION_KEYWORDS]), path);
    if (refStack.includes(node.$ref)) {
      projectionError(`${path}.$ref`, `cyclic reference ${JSON.stringify(node.$ref)}`);
    }
    const target = resolveLocalRef(root, node.$ref, `${path}.$ref`);
    const projectedTarget = projectNode(
      target,
      root,
      `${path}->$ref(${node.$ref})`,
      [...refStack, node.$ref],
      depth + 1,
    );
    return mergeProjectedRef(projectedTarget, annotations(node, path), path);
  }

  if (Array.isArray(node.type)) {
    assertOnly(node, new Set(["type", "format", "minimum", ...ANNOTATION_KEYWORDS]), path);
    if (node.type.length < 2 || new Set(node.type).size !== node.type.length) {
      projectionError(`${path}.type`, "type arrays require at least two unique types");
    }
    for (const type of node.type) {
      if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
        projectionError(`${path}.type`, `unsupported type ${JSON.stringify(type)}`);
      }
    }
    if (node.type.includes("number") && node.type.includes("integer")) {
      projectionError(`${path}.type`, "number and integer overlap and cannot be projected to oneOf");
    }
    const constrainedTypes = node.type.filter((type) => type !== "null");
    if (
      (Object.hasOwn(node, "format") || Object.hasOwn(node, "minimum")) &&
      (constrainedTypes.length !== 1 || !["number", "integer"].includes(constrainedTypes[0]))
    ) {
      projectionError(path, "format/minimum on a type union requires one numeric and one null branch");
    }
    const projected = {
      ...annotations(node, path),
      oneOf: node.type.map((type) => ({ type })),
    };
    appendCanonicalConstraints(projected, { ...node, type: constrainedTypes[0] }, path);
    return projected;
  }

  if (Object.hasOwn(node, "anyOf")) {
    assertOnly(node, new Set(["anyOf", ...ANNOTATION_KEYWORDS]), path);
    if (!Array.isArray(node.anyOf) || node.anyOf.length < 2) {
      projectionError(`${path}.anyOf`, "must contain at least two schema branches");
    }
    const branches = node.anyOf.map((branch, index) =>
      projectNode(branch, root, `${path}.anyOf[${index}]`, refStack, depth + 1),
    );
    assertBranchesDisjoint(branches, `${path}.anyOf`);
    return { ...annotations(node, path), oneOf: branches };
  }

  if (Object.hasOwn(node, "oneOf")) {
    assertOnly(node, new Set(["oneOf", ...ANNOTATION_KEYWORDS]), path);
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      projectionError(`${path}.oneOf`, "must contain at least two schema branches");
    }
    const projectedBranches = node.oneOf.map((branch, index) =>
      projectNode(branch, root, `${path}.oneOf[${index}]`, refStack, depth + 1),
    );
    return flattenTaggedObjectUnion(projectedBranches, annotations(node, path)) ?? {
      ...annotations(node, path),
      oneOf: projectedBranches,
    };
  }

  const projected = annotations(node, path);
  if (!Object.hasOwn(node, "type")) {
    assertOnly(node, new Set(ANNOTATION_KEYWORDS), path);
    return projected;
  }
  if (typeof node.type !== "string" || !SUPPORTED_TYPES.has(node.type)) {
    projectionError(`${path}.type`, `unsupported type ${JSON.stringify(node.type)}`);
  }
  projected.type = node.type;

  if (node.type === "object") {
    assertOnly(
      node,
      new Set(["type", "properties", "required", "additionalProperties", ...ANNOTATION_KEYWORDS]),
      path,
    );
    if (Object.hasOwn(node, "properties")) {
      if (!isRecord(node.properties)) projectionError(`${path}.properties`, "must be an object");
      projected.properties = Object.fromEntries(
        Object.entries(node.properties).map(([name, schema]) => [
          name,
          projectNode(schema, root, `${path}.properties.${name}`, refStack, depth + 1),
        ]),
      );
    }
    if (Object.hasOwn(node, "required")) {
      if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== "string")) {
        projectionError(`${path}.required`, "must be an array of strings");
      }
      for (const name of node.required) {
        if (!Object.hasOwn(node.properties ?? {}, name)) {
          projectionError(`${path}.required`, `names undeclared property ${JSON.stringify(name)}`);
        }
      }
      projected.required = [...node.required];
    }
    if (Object.hasOwn(node, "additionalProperties")) {
      if (typeof node.additionalProperties !== "boolean") {
        projectionError(`${path}.additionalProperties`, "must be a boolean");
      }
      projected.additionalProperties = node.additionalProperties;
    }
    return projected;
  }

  if (node.type === "array") {
    assertOnly(node, new Set(["type", "items", ...ANNOTATION_KEYWORDS]), path);
    if (Object.hasOwn(node, "items")) {
      projected.items = projectNode(node.items, root, `${path}.items`, refStack, depth + 1);
    }
    return projected;
  }

  assertOnly(
    node,
    new Set(["type", "enum", "const", "format", "minimum", ...ANNOTATION_KEYWORDS]),
    path,
  );
  if (Object.hasOwn(node, "enum")) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      projectionError(`${path}.enum`, "must be a non-empty array");
    }
    projected.enum = cloneJson(node.enum);
  }
  if (Object.hasOwn(node, "const")) projected.const = cloneJson(node.const);
  appendCanonicalConstraints(projected, node, path);
  return projected;
}

/**
 * Project one canonical MCP input schema into the strict schema vocabulary
 * consumed by DeepSeek Harness. The projection is model guidance only:
 * xuanling-mcp still validates the original canonical schema on tools/call.
 */
export function projectInputSchemaForDsh(schema) {
  if (!isRecord(schema)) projectionError("schema", "must be an object");
  const projected = projectNode(schema, schema, "schema", [], 0);
  if (projected.type !== "object") {
    projectionError("schema.type", "MCP tool parameters must project to an object root");
  }
  return projected;
}
