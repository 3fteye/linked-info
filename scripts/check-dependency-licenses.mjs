#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");

// Exact expressions are intentional. A new spelling or compound expression must
// be reviewed before it enters the build, even if all identifiers look familiar.
export const approvedRustLicenseExpressions = new Set([
  "(MIT OR Apache-2.0) AND Unicode-3.0",
  "0BSD OR MIT OR Apache-2.0",
  "Apache-2.0 / MIT",
  "Apache-2.0 AND ISC",
  "Apache-2.0 AND MIT",
  "Apache-2.0 OR BSL-1.0",
  "Apache-2.0 OR ISC OR MIT",
  "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT",
  "Apache-2.0 WITH LLVM-exception",
  "Apache-2.0 OR MIT OR Zlib",
  "Apache-2.0 OR MIT",
  "(Apache-2.0 OR MIT) AND BSD-3-Clause",
  "Apache-2.0",
  "Apache-2.0/MIT",
  "BSD-2-Clause OR Apache-2.0 OR MIT",
  "BSD-3-Clause AND MIT",
  "BSD-3-Clause",
  "BSD-3-Clause/MIT",
  "CC0-1.0 OR MIT-0 OR Apache-2.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "MIT AND BSD-3-Clause",
  "MIT OR Apache-2.0 OR Zlib",
  "MIT OR Apache-2.0",
  "MIT OR Zlib OR Apache-2.0",
  "MIT",
  "MIT/Apache-2.0",
  "MPL-2.0",
  "Unicode-3.0",
  "Unlicense OR MIT",
  "Unlicense/MIT",
  "Zlib OR Apache-2.0 OR MIT",
  "Zlib",
]);

export const approvedFrontendLicenseExpressions = new Set([
  "Apache-2.0 OR MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-4.0",
  "ISC",
  "MIT",
]);

const approvedRustSources = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
]);

function runJson(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`cannot run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`${command} exited with ${result.status}: ${details}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${command} did not return valid JSON: ${error.message}`);
  }
}

function packageLabel(packageInfo) {
  const versions = Array.isArray(packageInfo.versions)
    ? packageInfo.versions.join(",")
    : packageInfo.version;
  return `${packageInfo.name}@${versions}`;
}

export function findUnapprovedLicenseGroups(groups, approvedExpressions) {
  const failures = [];
  for (const [expression, packages] of groups) {
    if (!expression || !approvedExpressions.has(expression)) {
      failures.push({ expression: expression || "<missing>", packages });
    }
  }
  return failures;
}

export function inspectRustMetadata(metadata) {
  if (!Array.isArray(metadata?.packages) || !Array.isArray(metadata?.resolve?.nodes)) {
    throw new Error("unexpected cargo metadata structure");
  }

  const resolvedIds = new Set(metadata.resolve.nodes.map((node) => node.id));
  const packages = metadata.packages.filter((packageInfo) => resolvedIds.has(packageInfo.id));
  const groups = new Map();
  const sourceFailures = [];

  for (const packageInfo of packages) {
    const expression = packageInfo.license || "";
    const members = groups.get(expression) || [];
    members.push(packageInfo);
    groups.set(expression, members);

    if (packageInfo.source && !approvedRustSources.has(packageInfo.source)) {
      sourceFailures.push(packageInfo);
    }
  }

  return {
    packageCount: packages.length,
    groups,
    licenseFailures: findUnapprovedLicenseGroups(
      groups,
      approvedRustLicenseExpressions,
    ),
    sourceFailures,
  };
}

export function inspectFrontendLicenses(report) {
  if (!report || Array.isArray(report) || typeof report !== "object") {
    throw new Error("unexpected pnpm license report structure");
  }

  const groups = new Map();
  let packageCount = 0;
  for (const [expression, packages] of Object.entries(report)) {
    if (!Array.isArray(packages)) {
      throw new Error(`unexpected pnpm group for ${expression}`);
    }
    for (const packageInfo of packages) {
      if (packageInfo.license !== expression) {
        throw new Error(
          `pnpm grouped ${packageLabel(packageInfo)} under ${expression} but reported ${packageInfo.license}`,
        );
      }
    }
    groups.set(expression, packages);
    packageCount += packages.length;
  }

  return {
    packageCount,
    groups,
    licenseFailures: findUnapprovedLicenseGroups(
      groups,
      approvedFrontendLicenseExpressions,
    ),
  };
}

function formatFailures(ecosystem, failures) {
  return failures.map(({ expression, packages }) => {
    const examples = packages.slice(0, 8).map(packageLabel).join(", ");
    const remainder = packages.length > 8 ? ` and ${packages.length - 8} more` : "";
    return `${ecosystem}: unapproved license ${expression}: ${examples}${remainder}`;
  });
}

function main() {
  const rustTarget = process.env.LINKED_INFO_RUST_TARGET || "x86_64-pc-windows-msvc";
  // Node 24 rejects direct spawn of a .cmd shim on Windows. Keep the command
  // and all arguments constant, and use cmd.exe only to resolve pnpm's shim.
  const pnpmCommand = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "pnpm";
  const pnpmArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm", "licenses", "list", "--json"]
      : ["licenses", "list", "--json"];
  const rustMetadata = runJson(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--filter-platform",
      rustTarget,
    ],
    repoRoot,
  );
  const frontendReport = runJson(
    pnpmCommand,
    pnpmArgs,
    desktopRoot,
  );

  const rust = inspectRustMetadata(rustMetadata);
  const frontend = inspectFrontendLicenses(frontendReport);
  const failures = [
    ...formatFailures("Rust", rust.licenseFailures),
    ...rust.sourceFailures.map(
      (packageInfo) =>
        `Rust: unapproved dependency source ${packageInfo.source}: ${packageLabel(packageInfo)}`,
    ),
    ...formatFailures("Frontend", frontend.licenseFailures),
  ];

  if (failures.length > 0) {
    console.error("Dependency license review failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Rust license review passed: ${rust.packageCount} packages, ${rust.groups.size} approved expressions.`,
  );
  console.log(
    `Frontend license review passed: ${frontend.packageCount} packages, ${frontend.groups.size} approved expressions.`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
