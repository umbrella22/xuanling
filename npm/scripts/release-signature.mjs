const SIGNATURE_KIND = Object.freeze({
  "darwin-arm64": "developer-id-application",
  "linux-x64-gnu": "npm-provenance",
  "win32-x64-msvc": "authenticode",
});

function requireIdentity(args, targetId) {
  const identity = args["signature-identity"];
  if (typeof identity !== "string" || identity.trim().length === 0) {
    throw new Error(`${targetId} release signature requires --signature-identity`);
  }
  return identity.trim();
}

export function signatureFromArgs(args, targetId) {
  const kind = args["signature-kind"];
  if (kind === undefined) return undefined;
  if (kind !== SIGNATURE_KIND[targetId]) {
    throw new Error(
      `${targetId} requires signature kind ${SIGNATURE_KIND[targetId]}, received ${JSON.stringify(kind)}`,
    );
  }

  if (targetId === "darwin-arm64") {
    return {
      identity: requireIdentity(args, targetId),
      kind,
      status: "verified",
    };
  }
  if (targetId === "win32-x64-msvc") {
    if (args["signature-timestamped"] !== "true") {
      throw new Error(`${targetId} release signature requires --signature-timestamped true`);
    }
    return {
      identity: requireIdentity(args, targetId),
      kind,
      status: "verified",
      timestamped: true,
    };
  }
  if (targetId === "linux-x64-gnu") {
    if (args["signature-identity"] !== undefined || args["signature-timestamped"] !== undefined) {
      throw new Error(`${targetId} npm provenance metadata cannot carry signing identity fields`);
    }
    return {
      kind,
      status: "required-at-publish",
    };
  }
  throw new Error(`Unknown release signature target: ${targetId}`);
}

export function verifyReleaseSignature(signature, targetId) {
  if (signature === undefined || signature === null || typeof signature !== "object") {
    throw new Error(`${targetId} package is missing release signature metadata`);
  }
  const expectedKind = SIGNATURE_KIND[targetId];
  if (signature.kind !== expectedKind) {
    throw new Error(`${targetId} package requires signature kind ${expectedKind}`);
  }

  if (targetId === "linux-x64-gnu") {
    if (
      signature.status !== "required-at-publish"
      || Object.keys(signature).sort().join(",") !== "kind,status"
    ) {
      throw new Error(`${targetId} package has invalid npm provenance metadata`);
    }
    return;
  }

  if (signature.status !== "verified") {
    throw new Error(`${targetId} publisher signature is not verified`);
  }
  if (typeof signature.identity !== "string" || signature.identity.trim().length === 0) {
    throw new Error(`${targetId} publisher signature identity is missing`);
  }
  if (targetId === "darwin-arm64") {
    if (Object.keys(signature).sort().join(",") !== "identity,kind,status") {
      throw new Error(`${targetId} package has unexpected signature metadata`);
    }
    return;
  }
  if (
    signature.timestamped !== true
    || Object.keys(signature).sort().join(",") !== "identity,kind,status,timestamped"
  ) {
    throw new Error(`${targetId} Authenticode signature must be timestamped`);
  }
}
