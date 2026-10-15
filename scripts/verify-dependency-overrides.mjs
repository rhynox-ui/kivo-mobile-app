import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

assert.equal(packageJson.overrides?.uuid, "11.1.1", "uuid override must stay on patched 11.1.1");
assert.equal(packageJson.overrides?.["bigint-buffer"], "file:vendor/bigint-buffer-safe", "bigint-buffer must use the audited local replacement");
assert.equal(lock.packages["node_modules/bigint-buffer"]?.link, true, "bigint-buffer must link to the local patched package");
assert.equal(lock.packages["vendor/bigint-buffer-safe"]?.version, "1.1.6", "patched bigint-buffer must be locked at local version 1.1.6");
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
assert.throws(() => bigintBuffer.toBufferLE(0x10000n, 2), RangeError);
console.log("Dependency override verification passed: uuid and bigint-buffer replacements are locked and API-compatible.");
