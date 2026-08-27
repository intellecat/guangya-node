import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GuangyaClient, cdnUpload } from "../src/index.js";

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

type Handler = (req: Request) => Response | Promise<Response>;

class MockFetch {
  routes: Array<{ match: (url: string) => boolean; fn: Handler }> = [];
  requests: Request[] = [];
  body: unknown;

  add(match: (url: string) => boolean, fn: Handler): void {
    this.routes.push({ match, fn });
  }

  impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = url instanceof Request ? url : new Request(url.toString(), init);
    this.requests.push(req);
    for (const route of this.routes) {
      if (route.match(req.url)) return route.fn(req);
    }
    throw new Error(`no mock route for ${req.url}`);
  };
}

const token = {
  taskId: "T1",
  gcid: "GCID0000000000000000000000000000000000",
  creds: {
    accessKeyID: "AK",
    secretAccessKey: "SK",
    sessionToken: "ST",
    expiration: "2026-01-01T00:00:00Z",
  },
  provider: 1,
  endPoint: "oss.test",
  fullEndPoint: "https://oss.test",
  bucketName: "bkt",
  objectPath: "obj",
  region: "cn-qingdao",
};

describe("GuangyaClient", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gy-client-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adopts the access token returned by signin", async () => {
    const mock = new MockFetch();
    mock.add((url) => url.endsWith("/v1/auth/signin"), () =>
      json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
    );
    const client = new GuangyaClient({ fetchImpl: mock.impl });

    await client.loginSmsSignin({
      verificationCode: "1234",
      verificationToken: "VT",
      phoneNumber: "+86 13800000000",
      captchaToken: "CT",
    });

    assert.equal(client.token, "AT");
    assert.equal(client.refreshTokenValue, "RT");
    assert.ok(client.tokenExpiresAt !== undefined);
  });

  it("retries once with a fresh token after a 401", async () => {
    const mock = new MockFetch();
    let failed = false;
    mock.add(
      (url) => url.endsWith("/userres/v1/file/get_file_list"),
      () => {
        if (!failed) {
          failed = true;
          return new Response("", { status: 401 });
        }
        return json({ msg: "success", data: { total: 0, list: [] } });
      },
    );
    mock.add(
      (url) => url.endsWith("/v1/auth/token"),
      () => json({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }),
    );
    const client = new GuangyaClient({
      accessToken: "stale",
      refreshToken: "RT1",
      fetchImpl: mock.impl,
    });

    const res = await client.fsFiles({ parentId: "*" });

    assert.equal(res.msg, "success");
    assert.equal(client.token, "AT2");
    assert.equal(mock.requests.length, 3); // 401, refresh, retry
  });

  it("builds a correct get_file_list request body", async () => {
    const mock = new MockFetch();
    mock.add(
      (url) => url.endsWith("/userres/v1/file/get_file_list"),
      async (req) => {
        mock.body = await req.clone().json();
        return json({ msg: "success", data: { total: 0, list: [] } });
      },
    );
    const client = new GuangyaClient({ accessToken: "t", fetchImpl: mock.impl });

    await client.fsFiles({ parentId: "*", page: 1, pageSize: 25, resType: 1 });

    assert.deepEqual(mock.body, {
      parentId: "*",
      page: 1,
      pageSize: 25,
      orderBy: 0,
      sortType: 0,
      resType: 1,
    });
  });

  it("uploads a small file via a single PUT", async () => {
    const file = join(dir, "small.txt");
    writeFileSync(file, Buffer.from("hello world"));
    const mock = new MockFetch();
    mock.add((url) => url.endsWith("/get_res_center_token"), () =>
      json({ msg: "success", data: token }),
    );
    mock.add((url) => url.startsWith("https://oss.test/"), () =>
      new Response("", { status: 200 }),
    );
    let polls = 0;
    mock.add((url) => url.endsWith("/get_info_by_task_id"), () => {
      polls += 1;
      return polls === 1
        ? json({ msg: "文件上传中", code: 147 })
        : json({ msg: "success", data: { fileId: "F1" } });
    });
    const client = new GuangyaClient({ accessToken: "t", fetchImpl: mock.impl });

    const res = await client.fileUpload(file);

    assert.equal(res.msg, "success");
    const put = mock.requests.find((r) => r.method === "PUT");
    assert.ok(put, "expected an OSS PUT request");
    assert.equal(put.headers.get("content-md5") !== null, true);
  });

  it("uploads a large file in chunks and returns the ETag", async () => {
    const file = join(dir, "big.bin");
    writeFileSync(file, Buffer.from("abcdefg"));
    const mock = new MockFetch();
    mock.add(
      (url) => url.includes("?uploads="),
      () =>
        new Response(
          '<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>UID1</UploadId></InitiateMultipartUploadResult>',
          { status: 200 },
        ),
    );
    mock.add(
      (url) => url.includes("partNumber="),
      () =>
        new Response("", {
          status: 200,
          headers: { etag: '"part-etag"' },
        }),
    );
    mock.add(
      (url) => url.includes("uploadId=UID1"),
      () =>
        new Response(
          '<?xml version="1.0"?><CompleteMultipartUploadResult><ETag>"etag-done"</ETag></CompleteMultipartUploadResult>',
          { status: 200 },
        ),
    );

    const etag = await cdnUpload(file, token, { chunkSize: 3, fetchImpl: mock.impl });

    assert.equal(etag, '"etag-done"');
    const puts = mock.requests.filter((r) => r.method === "PUT");
    assert.equal(puts.length, 3); // 3 parts of 3 bytes
  });
});