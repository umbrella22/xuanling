const PUBLISHER_SIGNATURE_KIND = Object.freeze({
  "darwin-arm64": "developer-id-application",
  "win32-x64-msvc": "authenticode",
});
const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "linux-x64-gnu",
  "win32-x64-msvc",
]);

function exactKeys(value) {
  return Object.keys(value).sort().join(",");
}

function validateTargetId(targetId) {
  if (!SUPPORTED_TARGETS.has(targetId)) {
    throw new Error(`Unknown release trust target: ${targetId}`);
  }
}

function requireIdentity(args, targetId) {
  const identity = args["publisher-signature-identity"];
  if (typeof identity !== "string" || identity.trim().length === 0) {
    throw new Error(`${targetId} publisher signature requires --publisher-signature-identity`);
  }
  return identity.trim();
}

function publisherSigningFromArgs(args, targetId) {
  const kind = args["publisher-signature-kind"];
  if (kind === undefined) {
    if (
      args["publisher-signature-identity"] !== undefined
      || args["publisher-signature-timestamped"] !== undefined
    ) {
      throw new Error("publisher signature details require --publisher-signature-kind");
    }
    return { status: "not-provided" };
  }

  const expectedKind = PUBLISHER_SIGNATURE_KIND[targetId];
  if (kind !== expectedKind) {
    throw new Error(
      `${targetId} requires signature kind ${expectedKind ?? "not-supported"}, received ${JSON.stringify(kind)}`,
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
    if (args["publisher-signature-timestamped"] !== "true") {
      throw new Error(
        `${targetId} publisher signature requires --publisher-signature-timestamped true`,
      );
    }
    return {
      identity: requireIdentity(args, targetId),
      kind,
      status: "verified",
      timestamped: true,
    };
  }
  throw new Error(`Unknown publisher signature target: ${targetId}`);
}

export function releaseTrustFromArgs(args, targetId) {
  validateTargetId(targetId);
  return {
    npmProvenance: { status: "required-at-publish" },
    publisherSigning: publisherSigningFromArgs(args, targetId),
  };
}

export function verifyReleaseTrust(
  trust,
  targetId,
  { requirePublisherSignature = false } = {},
) {
  validateTargetId(targetId);
  if (trust === undefined || trust === null || typeof trust !== "object") {
    throw new Error(`${targetId} package is missing release trust metadata`);
  }
  if (exactKeys(trust) !== "npmProvenance,publisherSigning") {
    throw new Error(`${targetId} package has unexpected release trust metadata`);
  }
  if (
    trust.npmProvenance === null
    || typeof trust.npmProvenance !== "object"
    || exactKeys(trust.npmProvenance) !== "status"
    || trust.npmProvenance.status !== "required-at-publish"
  ) {
    throw new Error(`${targetId} package must require npm provenance at publish`);
  }

  const signing = trust.publisherSigning;
  if (signing === null || typeof signing !== "object") {
    throw new Error(`${targetId} package has invalid publisher signing metadata`);
  }
  if (signing.status === "not-provided") {
    if (exactKeys(signing) !== "status") {
      throw new Error(`${targetId} unsigned package has unexpected publisher signing metadata`);
    }
    if (requirePublisherSignature) {
      throw new Error(`${targetId} package requires a verified publisher signature`);
    }
    return;
  }
  if (signing.status !== "verified") {
    throw new Error(`${targetId} publisher signing status is invalid`);
  }

  const expectedKind = PUBLISHER_SIGNATURE_KIND[targetId];
  if (signing.kind !== expectedKind) {
    throw new Error(`${targetId} package requires signature kind ${expectedKind}`);
  }
  if (typeof signing.identity !== "string" || signing.identity.trim().length === 0) {
    throw new Error(`${targetId} publisher signature identity is missing`);
  }
  if (targetId === "darwin-arm64") {
    if (exactKeys(signing) !== "identity,kind,status") {
      throw new Error(`${targetId} package has unexpected signature metadata`);
    }
    return;
  }
  if (
    signing.timestamped !== true
    || exactKeys(signing) !== "identity,kind,status,timestamped"
  ) {
    throw new Error(`${targetId} Authenticode signature must be timestamped`);
  }
}
