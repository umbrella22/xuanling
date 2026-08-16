export const PACKAGE_NAME = "xuanling-mcp";

export const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    id: "darwin-arm64",
    alias: "xuanling-mcp-darwin-arm64",
    binary: "bin/xuanling-mcp",
    cpu: "arm64",
    os: "darwin",
    rustTarget: "aarch64-apple-darwin",
    distTag: "platform-darwin-arm64",
  }),
  "linux-x64-gnu": Object.freeze({
    id: "linux-x64-gnu",
    alias: "xuanling-mcp-linux-x64-gnu",
    binary: "bin/xuanling-mcp",
    cpu: "x64",
    libc: "glibc",
    os: "linux",
    rustTarget: "x86_64-unknown-linux-gnu",
    distTag: "platform-linux-x64-gnu",
  }),
  "win32-x64-msvc": Object.freeze({
    id: "win32-x64-msvc",
    alias: "xuanling-mcp-win32-x64-msvc",
    binary: "bin/xuanling-mcp.exe",
    cpu: "x64",
    os: "win32",
    rustTarget: "x86_64-pc-windows-msvc",
    distTag: "platform-win32-x64-msvc",
  }),
});

export function platformVersion(releaseVersion, targetId) {
  if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    throw new Error(
      `XuanLing npm releases require a stable semver version, received ${JSON.stringify(releaseVersion)}`,
    );
  }
  if (!Object.hasOwn(TARGETS, targetId)) {
    throw new Error(`Unknown XuanLing npm target: ${targetId}`);
  }
  return `${releaseVersion}-${targetId}`;
}

export function expectedOptionalDependencies(releaseVersion) {
  return Object.fromEntries(
    Object.values(TARGETS)
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map((target) => [
        target.alias,
        `npm:${PACKAGE_NAME}@${platformVersion(releaseVersion, target.id)}`,
      ]),
  );
}

const MINIMUM_GLIBC = Object.freeze({ major: 2, minor: 35 });

function runtimeGlibcVersion(report) {
  try {
    const header = report?.getReport?.()?.header;
    return typeof header?.glibcVersionRuntime === "string"
      ? header.glibcVersionRuntime
      : undefined;
  } catch {
    return undefined;
  }
}

function supportsMinimumGlibc(version) {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > MINIMUM_GLIBC.major ||
    (major === MINIMUM_GLIBC.major && minor >= MINIMUM_GLIBC.minor)
  );
}

export function detectTarget({
  platform = process.platform,
  arch = process.arch,
  report = process.report,
} = {}) {
  if (platform === "darwin" && arch === "arm64") {
    return TARGETS["darwin-arm64"];
  }
  if (platform === "win32" && arch === "x64") {
    return TARGETS["win32-x64-msvc"];
  }
  if (platform === "linux" && arch === "x64") {
    const glibcVersion = runtimeGlibcVersion(report);
    if (!glibcVersion) {
      throw new Error(
        "Unsupported Linux libc: xuanling-mcp currently publishes an x64 glibc binary, not musl",
      );
    }
    if (!supportsMinimumGlibc(glibcVersion)) {
      throw new Error(
        `Unsupported Linux glibc ${glibcVersion}: xuanling-mcp requires glibc 2.35 or newer`,
      );
    }
    return TARGETS["linux-x64-gnu"];
  }

  const supported = Object.values(TARGETS)
    .map((target) => `${target.os}/${target.cpu}${target.libc ? `/${target.libc}` : ""}`)
    .join(", ");
  throw new Error(
    `Unsupported platform: ${platform}/${arch}. Published targets: ${supported}`,
  );
}
