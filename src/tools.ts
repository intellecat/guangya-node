import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** Fake device id used by guangyapan's web client. */
export function generateDid(): string {
  return createHash("md5").update(randomBytes(16)).digest("hex");
}

/** W3C trace-context header, e.g. `00-<32 hex>-<16 hex>-01`. */
export function generateTraceparent(): string {
  const traceId = randomBytes(16).toString("hex");
  const parentId = randomBytes(8).toString("hex");
  return `00-${traceId}-${parentId}-01`;
}

/**
 * Compute a file's gcid (guangyapan's content hash).
 *
 * Chunk size grows with file size; each chunk is sha1'd, then the
 * concatenated digests are sha1'd again.
 */
export function calculateGcid(filePath: string): string {
  const size = statSync(filePath).size;
  const chunkSize =
    size <= 0x80_00_00 ? 0x4_00_00
    : size <= 0x10_00_00_00 ? 0x8_00_00
    : size <= 0x20_00_00_00 ? 0x10_00_00
    : 0x20_00_00;

  const hashes: Buffer[] = [];
  const buf = Buffer.allocUnsafe(chunkSize);
  const fd = openSync(filePath, "r");
  try {
    let offset = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, chunkSize, offset);
      if (read <= 0) break;
      hashes.push(createHash("sha1").update(buf.subarray(0, read)).digest());
      offset += read;
    }
  } finally {
    closeSync(fd);
  }

  return createHash("sha1").update(Buffer.concat(hashes)).digest("hex").toUpperCase();
}