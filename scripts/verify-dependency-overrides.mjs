import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// Guard audited dependency replacements and their API compatibility so lockfile refreshes cannot silently restore vulnerable versions.
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

assert.equal(packageJson.overrides?.uuid, "11.1.1", "uuid override must stay on patched 11.1.1");
assert.equal(packageJson.overrides?.toml, "5.0.1", "toml override must stay on patched 5.0.1");
assert.equal(lock.packages["node_modules/toml"]?.version, "5.0.1", "lockfile must resolve patched toml 5.0.1");
assert.equal(packageJson.dependencies?.["bigint-buffer"], "file:vendor/bigint-buffer-safe", "bigint-buffer must use the vendored input-validation replacement");
assert.equal(lock.packages["node_modules/bigint-buffer"]?.link, true, "bigint-buffer must link to the local replacement");
assert.equal(lock.packages["vendor/bigint-buffer-safe"]?.version, "1.1.6", "local bigint-buffer replacement must stay pinned");
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
const bigintBuffer = require("bigint-buffer");
assert.equal(bigintBuffer.toBigIntLE(Buffer.from([0x34, 0x12])), 0x1234n);
assert.equal(bigintBuffer.toBigIntBE(Buffer.from([0x12, 0x34])), 0x1234n);
assert.deepEqual(bigintBuffer.toBufferLE(0x1234n, 2), Buffer.from([0x34, 0x12]));
assert.deepEqual(bigintBuffer.toBufferBE(0x1234n, 2), Buffer.from([0x12, 0x34]));
assert.throws(() => bigintBuffer.toBigIntLE(null), TypeError);
console.log("Dependency verification passed: uuid 11.1.1 and vendored bigint-buffer replacement APIs are compatible.");
