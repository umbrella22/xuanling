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
