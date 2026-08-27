import { createHash, createHmac } from "node:crypto";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import type { UploadTokenData } from "./types.js";

export interface SignedHeaders {
  authorization: string;
  "x-oss-date": string;
  "x-oss-security-token"?: string;
  "content-type"?: string;
  "content-md5"?: string;
  [key: string]: string | undefined;
}

export interface SignOptions {
  contentType?: string;
  contentMd5?: string;
  subResources?: Record<string, string | null>;
  /** Injectable clock for deterministic signatures. */
  date?: string;
}

/** Sign a request the way Aliyun OSS expects. */
export function ossSignHeaders(
  method: string,
  bucket: string,
  objectKey: string,
  accessKeyId: string,
  secretAccessKey: string,
  securityToken: string,
  opts: SignOptions = {},
): SignedHeaders {
  const date = opts.date ?? new Date().toUTCString();
  const { contentType = "", contentMd5 = "" } = opts;

  const canonicalHeaders: Record<string, string> = {
    "x-oss-date": date,
  };
  if (securityToken.trim()) {
    canonicalHeaders["x-oss-security-token"] = securityToken.trim();
  }

  let resource = `/${bucket}/${objectKey}`;
  if (opts.subResources) {
    const qs = Object.entries(opts.subResources)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => (v ? `${k}=${v}` : k))
      .join("&");
    resource += `?${qs}`;
  }

  const canonical = [
    method.toUpperCase(),
    contentMd5,
    contentType,
    date,
    ...Object.entries(canonicalHeaders)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}:${v}`),
    resource,
  ].join("\n");

  const signature = createHmac("sha1", secretAccessKey)
    .update(canonical, "utf8")
    .digest("base64");

  const headers: SignedHeaders = {
    authorization: `OSS ${accessKeyId}:${signature}`,
    "x-oss-date": date,
  };
  if (securityToken.trim()) headers["x-oss-security-token"] = securityToken.trim();
  if (contentType) headers["content-type"] = contentType;
  if (contentMd5) headers["content-md5"] = contentMd5;
  return headers;
}

function b64md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("base64");
}

function extractXmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, "s"));
  if (!match) throw new Error(`missing <${tag}> in OSS response: ${xml}`);
  return match[1]!;
}

interface OssRequestParams {
  method: string;
  url: string;
  token: UploadTokenData;
  content?: Buffer;
  contentType?: string;
  contentMd5?: string;
  subResources?: Record<string, string | null>;
  fetchImpl?: typeof fetch;
}

/** Copy a Buffer into a standalone ArrayBuffer (fetch-safe on all Node versions). */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

async function ossRequest(params: OssRequestParams): Promise<Response> {
  const { token } = params;
  const { creds } = token;
  const signed = ossSignHeaders(
    params.method,
    token.bucketName,
    token.objectPath,
    creds.accessKeyID,
    creds.secretAccessKey,
    creds.sessionToken,
    {
      contentType: params.contentType,
      contentMd5: params.contentMd5,
      subResources: params.subResources,
    },
  );
  const headers = new Headers();
  for (const [key, value] of Object.entries(signed)) {
    if (value !== undefined) headers.set(key, value);
  }
  const query = params.subResources
    ? `?${new URLSearchParams(
        Object.fromEntries(
          Object.entries(params.subResources).map(([k, v]) => [k, v ?? ""]),
        ),
      ).toString()}`
    : "";
  const res = await (params.fetchImpl ?? fetch)(params.url + query, {
    method: params.method,
    headers,
    body: params.content ? toArrayBuffer(params.content) : undefined,
  });
  if (!res.ok) {
    throw new Error(
      `OSS ${params.method} failed: ${res.status} ${await res.text()}`,
    );
  }
  return res;
}

/**
 * Multipart (chunked) upload of a local file to guangyapan's OSS.
 * Returns the ETag of the completed multipart upload.
 */
export async function cdnUpload(
  filePath: string,
  token: UploadTokenData,
  opts: { contentType?: string; chunkSize?: number; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const { fetchImpl } = opts;
  const contentType = opts.contentType ?? "application/octet-stream";
  const chunkSize = opts.chunkSize ?? 5 * 1024 * 1024;
  const baseUrl = `${token.fullEndPoint}/${token.objectPath}`;

  const initResp = await ossRequest({
    method: "POST",
    url: baseUrl,
    token,
    contentType,
    subResources: { uploads: "" },
    fetchImpl,
  });
  const uploadId = extractXmlTag(await initResp.text(), "UploadId");

  const size = statSync(filePath).size;
  const fd = openSync(filePath, "r");
  const parts: Array<{ number: number; etag: string }> = [];
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    let partNumber = 1;
    while (offset < size) {
      const read = readSync(fd, buf, 0, chunkSize, offset);
      if (read <= 0) break;
      const chunk = buf.subarray(0, read);
      const resp = await ossRequest({
        method: "PUT",
        url: baseUrl,
        token,
        content: chunk,
        contentType: "application/octet-stream",
        contentMd5: b64md5(chunk),
        subResources: { partNumber: String(partNumber), uploadId },
        fetchImpl,
      });
      const etag = (resp.headers.get("etag") ?? "").replace(/"/g, "");
      parts.push({ number: partNumber, etag });
      partNumber += 1;
      offset += read;
    }
  } finally {
    closeSync(fd);
  }

  const xmlParts = parts
    .map(
      (p) =>
        `<Part><PartNumber>${p.number}</PartNumber><ETag>"${p.etag}"</ETag></Part>`,
    )
    .join("");
  const xmlBody = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${xmlParts}</CompleteMultipartUpload>`,
    "utf8",
  );
  const completeResp = await ossRequest({
    method: "POST",
    url: baseUrl,
    token,
    content: xmlBody,
    contentType: "application/xml",
    contentMd5: b64md5(xmlBody),
    subResources: { uploadId },
    fetchImpl,
  });
  return extractXmlTag(await completeResp.text(), "ETag");
}

/** Upload a small file with a single PUT (used when a file is < 1 MB). */
export async function directPut(
  filePath: string,
  token: UploadTokenData,
  contentMd5: string,
  opts: { contentType?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(size);
  try {
    readSync(fd, buf, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  await ossRequest({
    method: "PUT",
    url: `${token.fullEndPoint}/${token.objectPath}`,
    token,
    content: buf,
    contentType: opts.contentType ?? "application/octet-stream",
    contentMd5,
    fetchImpl: opts.fetchImpl,
  });
}