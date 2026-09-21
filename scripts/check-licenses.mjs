#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const packages = Object.entries(lock.packages || {}).filter(([location]) => location);
const review = [];

for (const [location, pkg] of packages) {
  const license = String(pkg.license || "").trim();
  if (!license) {
    review.push(`${location}: missing license metadata in package-lock.json`);
    continue;
  }
  if (/UNLICENSED|SEE LICENSE|AGPL|SSPL|BUSL|Commons Clause/i.test(license)) {
    review.push(`${location}: ${license}`);
  }
}

if (review.length) {
  console.error("dependency license review required:\n" + review.join("\n"));
  process.exit(1);
}

console.log(`dependency license metadata check passed: ${packages.length} locked packages`);
