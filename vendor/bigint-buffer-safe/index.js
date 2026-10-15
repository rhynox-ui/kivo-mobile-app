function assertBuffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new TypeError(`${name}: expected a Buffer`);
  }
}

function toBigIntBE(buffer) {
  assertBuffer(buffer, "toBigIntBE");
  if (buffer.length === 0) return 0n;
  return BigInt(`0x${buffer.toString("hex")}`);
}

function toBigIntLE(buffer) {
  assertBuffer(buffer, "toBigIntLE");
  return toBigIntBE(Buffer.from(buffer).reverse());
}

function assertLength(length) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("length must be a non-negative safe integer");
  }
}

function toBigIntValue(value, name) {
  if (typeof value !== "bigint" && !(typeof value === "number" && Number.isSafeInteger(value))) {
    throw new TypeError(`${name}: expected a bigint or safe integer`);
  }
  const result = BigInt(value);
  if (result < 0n) throw new RangeError(`${name}: value must be non-negative`);
  return result;
}

function toBufferBE(value, length) {
  const number = toBigIntValue(value, "toBufferBE");
  assertLength(length);
  if (length === 0) {
    if (number !== 0n) throw new RangeError("value does not fit in the requested buffer length");
    return Buffer.alloc(0);
  }
  if (number >= (1n << BigInt(length * 8))) {
    throw new RangeError("value does not fit in the requested buffer length");
  }
  const hex = number.toString(16).padStart(length * 2, "0");
  return Buffer.from(hex, "hex");
}

function toBufferLE(value, length) {
  return Buffer.from(toBufferBE(value, length)).reverse();
}

module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
