import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { calculateGcid, generateDid, generateTraceparent } from "../src/index.js";

describe("calculateGcid", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gy-tools-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches the reference gcid for a single-chunk file", () => {
    const file = join(dir, "ref1.bin");
    writeFileSync(file, Buffer.from("hello world"));
    assert.equal(calculateGcid(file), "67BECF85308ACF0261750DA1075681EE5C412F05");
  });

  it("matches the reference gcid across a chunk boundary (2 chunks)", () => {
    const file = join(dir, "ref2.bin");
    writeFileSync(file, Buffer.from("x".repeat(262_145)));
    assert.equal(calculateGcid(file), "C5F0FEC34D22766F5FBF6DC3465801A3BFC3B8B9");
  });

  it("returns a 40-char uppercase hex string", () => {
    const file = join(dir, "any.bin");
    writeFileSync(file, Buffer.from([1, 2, 3]));
    const gcid = calculateGcid(file);
    assert.match(gcid, /^[0-9A-F]{40}$/);
  });
});

describe("generateDid", () => {
  it("returns a 32-char hex string and is unique per call", () => {
    const a = generateDid();
    const b = generateDid();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, b);
  });
});

describe("generateTraceparent", () => {
  it("follows the W3C trace-context format", () => {
    const tp = generateTraceparent();
    assert.match(tp, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});