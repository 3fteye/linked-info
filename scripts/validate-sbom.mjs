#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function validateSbom(filePath) {
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (document.bomFormat !== "CycloneDX") {
    throw new Error(`${filePath}: bomFormat is not CycloneDX`);
  }
  if (document.specVersion !== "1.5") {
    throw new Error(`${filePath}: expected CycloneDX 1.5, got ${document.specVersion}`);
  }
  if (!document.metadata?.component?.name) {
    throw new Error(`${filePath}: metadata.component.name is missing`);
  }
  if (!Array.isArray(document.components) || document.components.length === 0) {
    throw new Error(`${filePath}: components are missing`);
  }

  console.log(
    `${path.basename(filePath)}: CycloneDX ${document.specVersion}, ${document.components.length} components.`,
  );
}

if (process.argv.length < 3) {
  console.error("Usage: node scripts/validate-sbom.mjs <sbom.json> [more.json]");
  process.exit(2);
}

for (const filePath of process.argv.slice(2)) validateSbom(filePath);
