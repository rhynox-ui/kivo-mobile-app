// Adapted from bigint-buffer-safe (MIT), Copyright (c) 2026 Heathen.
// Kivo maintains this dependency locally until the upstream package publishes a registry artifact.
function assertBuffer(value, fnName) {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${fnName}: expected a Buffer, got ${value === null ? "null" : typeof value}`);
  }
}
function assertBigInt(value, fnName) {
  if (typeof value !== "bigint") {
    throw new TypeError(`${fnName}: expected a bigint, got ${value === null ? "null" : typeof value}`);
  }
}
function assertWidth(value, fnName) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1048576) {
    throw new TypeError(`${fnName}: expected a non-negative safe integer width up to 1 MiB`);
  }
}
function toBigIntBE(buf) {
  assertBuffer(buf, "toBigIntBE");
  if (buf.length === 0) return 0n;
  return BigInt("0x" + buf.toString("hex"));
}
function toBigIntLE(buf) {
  assertBuffer(buf, "toBigIntLE");
  if (buf.length === 0) return 0n;
  return toBigIntBE(Buffer.from(buf).reverse());
}
function toBufferBE(num, width) {
  assertBigInt(num, "toBufferBE");
  assertWidth(width, "toBufferBE");
  if (width === 0) return Buffer.alloc(0);
  const hex = num.toString(16).padStart(width * 2, "0");
  return Buffer.from(hex.slice(-width * 2), "hex");
}
function toBufferLE(num, width) {
  assertBigInt(num, "toBufferLE");
  assertWidth(width, "toBufferLE");
  if (width === 0) return Buffer.alloc(0);
  return Buffer.from(toBufferBE(num, width)).reverse();
}
module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
