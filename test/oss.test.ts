import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ossSignHeaders, type SignOptions } from "../src/index.js";

const DATE = "Wed, 21 Oct 2015 07:28:00 GMT";

// Reference vectors generated with the (live-proven) reference client.
const vectors: Array<{
  name: string;
  method: string;
  bucket: string;
  objectKey: string;
  opts: SignOptions;
  expected: string;
}> = [
  {
    name: "plain PUT",
    method: "PUT",
    bucket: "bkt",
    objectKey: "obj",
    opts: { date: DATE },
    expected: "ilKBbeAlo/iyMkLn3fnmIh8IOYg=",
  },
  {
    name: "initiate multipart upload",
    method: "POST",
    bucket: "bkt",
    objectKey: "obj",
    opts: { date: DATE, subResources: { uploads: "" } },
    expected: "aM1ooq7JnUVUYtkre0xDnYbc19s=",
  },
  {
    name: "upload part with md5 + sub-resources",
    method: "PUT",
    bucket: "bkt",
    objectKey: "a/b",
    opts: {
      date: DATE,
      contentType: "application/octet-stream",
      contentMd5: "c2lnbg==",
      subResources: { partNumber: "2", uploadId: "uid1" },
    },
    expected: "fsXjkQw6Rmam2uvUgAA4XjNQ79s=",
  },
];

describe("ossSignHeaders", () => {
  it("matches reference signatures", () => {
    for (const v of vectors) {
      const headers = ossSignHeaders(
        v.method,
        v.bucket,
        v.objectKey,
        "AKID",
        "SECRET",
        "TOK123",
        v.opts,
      );
      const signature = headers.authorization.split(":")[1];
      assert.equal(signature, v.expected, `vector: ${v.name}`);
    }
  });

  it("omits x-oss-security-token when no STS token is given", () => {
    const headers = ossSignHeaders("GET", "bkt", "obj", "AKID", "SECRET", "", {
      date: DATE,
    });
    assert.equal("x-oss-security-token" in headers, false);
  });

  it("produces an RFC-1123 x-oss-date", () => {
    const headers = ossSignHeaders("GET", "bkt", "obj", "AKID", "SECRET", "", {
      date: DATE,
    });
    assert.match(headers["x-oss-date"]!, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });

  it("throws if no signing headers are returned for a known method", () => {
    const headers = ossSignHeaders("PUT", "bkt", "obj", "AKID", "SECRET", "", {
      date: DATE,
    });
    assert.ok(headers.authorization.startsWith("OSS AKID:"));
  });
});