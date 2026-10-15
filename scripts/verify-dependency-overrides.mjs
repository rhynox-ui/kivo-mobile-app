import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// Guard the audited compatibility overrides so future lockfile refreshes cannot silently restore vulnerable versions.
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

assert.equal(packageJson.overrides?.uuid, "11.1.1", "uuid override must stay on patched 11.1.1");
const uuidLockEntries = Object.entries(lock.packages).filter(([path]) =>
  path === "node_modules/uuid" || path.endsWith("/node_modules/uuid")
);
assert.ok(uuidLockEntries.length > 0, "expected uuid package-lock entries");
for (const [path, entry] of uuidLockEntries) {
  assert.equal(entry.version, "11.1.1", `${path} must resolve to uuid 11.1.1`);
}

const require = createRequire(import.meta.url);
const uuid = require("uuid");
assert.equal(typeof uuid.v4, "function", "uuid v4 CommonJS API must remain available to jayson");
console.log("Dependency override verification passed: uuid 11.1.1 is locked and v4 API is available.");
