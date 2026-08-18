export function classifyIntegrityLookup(result, { expectedIntegrity, specifier }) {
  if (result.exitCode === undefined) {
    let publishedIntegrity;
    try {
      publishedIntegrity = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `${specifier} registry lookup returned invalid JSON: ${result.stdout.trim()}`,
      );
    }
    if (typeof publishedIntegrity !== "string" || publishedIntegrity.length === 0) {
      throw new Error(
        `${specifier} registry lookup returned an invalid integrity: ${result.stdout.trim()}`,
      );
    }
    if (publishedIntegrity !== expectedIntegrity) {
      throw new Error(
        `${specifier} already exists with integrity ${publishedIntegrity}; local tarball is ${expectedIntegrity}`,
      );
    }
    return { action: "skip", integrity: publishedIntegrity };
  }

  if (`${result.stdout}\n${result.stderr}`.includes("E404")) {
    return { action: "publish" };
  }
  throw new Error(`Unable to query ${specifier}:\n${result.stderr || result.stdout}`);
}

export const PUBLISH_RECONCILIATION_DELAYS_MS = Object.freeze([
  0,
  2_000,
  4_000,
  8_000,
  16_000,
  30_000,
  30_000,
  30_000,
]);

export async function reconcilePublishedIntegrity({
  expectedIntegrity,
  lookup,
  onRetry = () => {},
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  specifier,
}) {
  let elapsedMs = 0;
  for (let index = 0; index < PUBLISH_RECONCILIATION_DELAYS_MS.length; index += 1) {
    const delayMs = PUBLISH_RECONCILIATION_DELAYS_MS[index];
    if (delayMs > 0) {
      onRetry({
        attempt: index + 1,
        delayMs,
        totalAttempts: PUBLISH_RECONCILIATION_DELAYS_MS.length,
      });
      await sleep(delayMs);
      elapsedMs += delayMs;
    }

    const decision = classifyIntegrityLookup(await lookup(), {
      expectedIntegrity,
      specifier,
    });
    if (decision.action === "skip") {
      return {
        attempts: index + 1,
        elapsedMs,
        integrity: decision.integrity,
      };
    }
  }

  throw new Error(
    `${specifier} did not become visible after ${PUBLISH_RECONCILIATION_DELAYS_MS.length} `
      + `reconciliation lookups over ${elapsedMs / 1_000} seconds`,
  );
}
