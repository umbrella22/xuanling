export const NPM_SCOPE = "@xuanling-rs";
export const PACKAGE_BASENAME = "harness-bridge";
export const PACKAGE_NAME = `${NPM_SCOPE}/${PACKAGE_BASENAME}`;

export const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    id: "darwin-arm64",
    alias: "harness-bridge-darwin-arm64",
    packageName: `${NPM_SCOPE}/harness-bridge-darwin-arm64`,
    binary: "bin/harness-bridge",
    cpu: "arm64",
    os: "darwin",
    rustTarget: "aarch64-apple-darwin",
  }),
  "linux-x64-gnu": Object.freeze({
    id: "linux-x64-gnu",
    alias: "harness-bridge-linux-x64-gnu",
    packageName: `${NPM_SCOPE}/harness-bridge-linux-x64-gnu`,
    binary: "bin/harness-bridge",
    cpu: "x64",
    libc: "glibc",
    os: "linux",
    rustTarget: "x86_64-unknown-linux-gnu",
  }),
  "win32-x64-msvc": Object.freeze({
    id: "win32-x64-msvc",
    alias: "harness-bridge-win32-x64-msvc",
    packageName: `${NPM_SCOPE}/harness-bridge-win32-x64-msvc`,
    binary: "bin/harness-bridge.exe",
    cpu: "x64",
    os: "win32",
    rustTarget: "x86_64-pc-windows-msvc",
  }),
});

export function platformVersion(releaseVersion, targetId) {
  if (!/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    throw new Error(
      `XuanLing npm releases require a stable semver version, received ${JSON.stringify(releaseVersion)}`,
    );
  }
  if (!Object.hasOwn(TARGETS, targetId)) {
    throw new Error(`Unknown XuanLing harness-bridge npm target: ${targetId}`);
  }
  return `${releaseVersion}-${targetId}`;
}

export function expectedOptionalDependencies(releaseVersion) {
  return Object.fromEntries(
    Object.values(TARGETS).map((target) => [
      target.alias,
      `npm:${target.packageName}@${platformVersion(releaseVersion, target.id)}`,
    ]),
  );
}

export function detectTarget({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch === "arm64") {
    return TARGETS["darwin-arm64"];
  }
  if (platform === "win32" && arch === "x64") {
    return TARGETS["win32-x64-msvc"];
  }
  if (platform === "linux" && arch === "x64") {
    return TARGETS["linux-x64-gnu"];
  }

  const supported = Object.values(TARGETS)
    .map((target) => `${target.os}/${target.cpu}${target.libc ? `/${target.libc}` : ""}`)
    .join(", ");
  throw new Error(
    `Unsupported platform: ${platform}/${arch}. Supported targets: ${supported}`,
  );
}
