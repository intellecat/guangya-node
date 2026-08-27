import { createHash, randomBytes } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { readFileSync, statSync } from "node:fs";
import { setDefaultAutoSelectFamily } from "node:net";
import { basename } from "node:path";

setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { calculateGcid, generateDid, generateTraceparent } from "./tools.js";
import { cdnUpload, directPut } from "./oss.js";
import {
  type ApiResponse,
  type FileDetail,
  type ListFilesData,
  type ListFilesParams,
  type SignInResult,
  type UploadTokenData,
} from "./types.js";

const ACCOUNT_BASE = "https://account.guangyapan.com";
const API_BASE = "https://api.guangyapan.com";
const CLIENT_ID = "aMe-8VSlkrbQXpUR";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export interface GuangyaClientOptions {
  accessToken?: string;
  refreshToken?: string;
  deviceId?: string;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method?: string;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
}

interface LoginSigninParams {
  verificationCode: string;
  verificationToken: string;
  phoneNumber: string;
  captchaToken: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GuangyaClient {
  readonly deviceId: string;
  token: string;
  tokenExpiresAt?: number;
  refreshTokenValue?: string;
  readonly #fetch: typeof fetch;
  #did: string;

  constructor(opts: GuangyaClientOptions = {}) {
    this.token = opts.accessToken ?? "";
    this.refreshTokenValue = opts.refreshToken;
    this.deviceId = opts.deviceId ?? generateDid();
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#did = generateDid();
  }

  // ---------------------------------------------------------------- http

  #baseHeaders(): Record<string, string> {
    return {
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${this.token}`,
      did: this.#did,
      dt: "4",
      origin: "https://www.guangyapan.com",
      referer: "https://www.guangyapan.com/",
      "user-agent": USER_AGENT,
    };
  }

  #accountHeaders(): Record<string, string> {
    return {
      accept: "*/*",
      origin: "https://www.guangyapan.com",
      referer: "https://www.guangyapan.com/",
      "user-agent": USER_AGENT,
      "x-client-id": CLIENT_ID,
      "x-client-version": "0.0.1",
      "x-device-id": this.deviceId,
      "x-device-model": "chrome%2F147.0.0.0",
      "x-device-name": "PC-Chrome",
      "x-device-sign": `wdi10.${this.deviceId}${randomBytes(16).toString("hex")}`,
      "x-net-work-type": "NONE",
      "x-os-version": "MacIntel",
      "x-platform-version": "1",
      "x-protocol-version": "301",
      "x-provider-name": "NONE",
      "x-sdk-version": "9.0.2",
    };
  }

  #buildInit(opts: RequestOptions): RequestInit {
    const headers: Record<string, string> = {
      traceparent: generateTraceparent(),
      ...this.#baseHeaders(),
      ...opts.headers,
    };
    const init: RequestInit = { method: opts.method ?? "POST", headers };
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      init.body = opts.body;
      if (init.body instanceof FormData) delete headers["content-type"];
    }
    return init;
  }

  async #send(url: string, opts: RequestOptions): Promise<ApiResponse> {
    await this.#refreshIfExpired();
    let init = this.#buildInit(opts);
    let res = await this.#fetch(url, init);
    if (res.status === 401 && this.refreshTokenValue) {
      await this.refreshToken();
      init = this.#buildInit(opts);
      res = await this.#fetch(url, init);
    }
    if (!res.ok) throw new HttpError(res.status, await res.text());
    return (await res.json()) as ApiResponse;
  }

  async request<T = unknown>(
    url: string,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    return this.#send(url, opts) as Promise<ApiResponse<T>>;
  }

  async #refreshIfExpired(): Promise<void> {
    if (
      this.refreshTokenValue &&
      this.tokenExpiresAt !== undefined &&
      Date.now() / 1000 >= this.tokenExpiresAt
    ) {
      await this.refreshToken();
    }
  }

  // ---------------------------------------------------------------- auth

  async loginSmsInit(phoneNumber: string, captchaToken?: string): Promise<ApiResponse<{ captcha_token?: string }>> {
    const body: Record<string, unknown> = {
      client_id: CLIENT_ID,
      action: "POST:/v1/auth/verification",
      device_id: this.deviceId,
      meta: { phone_number: phoneNumber },
    };
    if (captchaToken) body.captcha_token = captchaToken;
    return this.request("https://account.guangyapan.com/v1/shield/captcha/init", {
      headers: this.#accountHeaders(),
      json: body,
    });
  }

  async loginSmsSend(phoneNumber: string, captchaToken: string, target = "ANY"): Promise<ApiResponse<{ verification_id?: string }>> {
    return this.request("https://account.guangyapan.com/v1/auth/verification", {
      headers: { ...this.#accountHeaders(), "x-captcha-token": captchaToken },
      json: { phone_number: phoneNumber, target, client_id: CLIENT_ID },
    });
  }

  async loginSmsVerify(verificationId: string, code: string): Promise<ApiResponse<{ verification_token?: string }>> {
    return this.request("https://account.guangyapan.com/v1/auth/verification/verify", {
      headers: this.#accountHeaders(),
      json: { verification_id: verificationId, verification_code: code, client_id: CLIENT_ID },
    });
  }

  async loginSmsSignin({ verificationCode, verificationToken, phoneNumber, captchaToken }: LoginSigninParams): Promise<ApiResponse<SignInResult>> {
    const res = await this.request<SignInResult>(
      "https://account.guangyapan.com/v1/auth/signin",
      {
        headers: { ...this.#accountHeaders(), "x-captcha-token": captchaToken },
        json: {
          verification_code: verificationCode,
          verification_token: verificationToken,
          username: phoneNumber,
          client_id: CLIENT_ID,
        },
      },
    );
    this.#adoptSignIn(res);
    return res;
  }

  async refreshToken(): Promise<ApiResponse<SignInResult>> {
    if (!this.refreshTokenValue) throw new Error("no refresh token available");
    const res = await this.request<SignInResult>("https://account.guangyapan.com/v1/auth/token", {
      headers: { ...this.#accountHeaders(), "x-action": "401" },
      json: {
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: this.refreshTokenValue,
      },
    });
    this.#adoptSignIn(res);
    return res;
  }

  #adoptSignIn(resp: ApiResponse<SignInResult>): void {
    const data = (resp.data ?? resp) as SignInResult;
    if (!data?.access_token) return;
    this.token = data.access_token;
    if (data.expires_in !== undefined) {
      this.tokenExpiresAt = Date.now() / 1000 + data.expires_in;
    }
    this.refreshTokenValue = data.refresh_token ?? this.refreshTokenValue;
  }

  /**
   * Full SMS login. `getCode` is called once after the SMS is dispatched;
   * if omitted it reads a line from stdin.
   */
  async loginSms(
    phoneNumber: string,
    getCode: () => string | Promise<string> = () => readLine("请输入短信验证码: "),
    target = "ANY",
  ): Promise<ApiResponse<SignInResult>> {
    const init = await this.loginSmsInit(phoneNumber);
    const captchaToken = init.data?.captcha_token;
    if (!captchaToken) throw new Error(`login init failed: ${JSON.stringify(init)}`);

    const sent = await this.loginSmsSend(phoneNumber, captchaToken, target);
    const verificationId = sent.data?.verification_id;
    if (!verificationId) throw new Error(`sms send failed: ${JSON.stringify(sent)}`);

    const code = await getCode();
    const verified = await this.loginSmsVerify(verificationId, code);
    const verificationToken = verified.data?.verification_token;
    if (!verificationToken) throw new Error(`verify failed: ${JSON.stringify(verified)}`);

    return this.loginSmsSignin({
      verificationCode: code,
      verificationToken,
      phoneNumber,
      captchaToken,
    });
  }

  // ---------------------------------------------------------------- user

  async userInfo(): Promise<ApiResponse> {
    return this.request("https://account.guangyapan.com/v1/user/me", {
      headers: this.#accountHeaders(),
    });
  }

  // ---------------------------------------------------------------- fs

  async fsFiles(params: ListFilesParams = {}): Promise<ApiResponse<ListFilesData>> {
    const body: Record<string, unknown> = {
      parentId: params.parentId ?? "",
      page: params.page ?? 0,
      pageSize: params.pageSize ?? 50,
      orderBy: params.orderBy ?? 0,
      sortType: params.sortType ?? 0,
    };
    if (params.fileTypes !== undefined) body.fileTypes = params.fileTypes;
    if (params.resType !== undefined) body.resType = params.resType;
    if (params.dirType !== undefined) body.dirType = params.dirType;
    if (params.needPlayRecord) body.needPlayRecord = true;
    return this.request(`${API_BASE}/userres/v1/file/get_file_list`, { json: body });
  }

  fsImageList(page = 0, pageSize = 50, orderBy = 3, sortType = 1): Promise<ApiResponse<ListFilesData>> {
    return this.fsFiles({ parentId: "*", page, pageSize, orderBy, sortType, fileTypes: [1], resType: 1 });
  }

  fsVideoList(page = 0, pageSize = 50, orderBy = 3, sortType = 1): Promise<ApiResponse<ListFilesData>> {
    return this.fsFiles({ parentId: "*", page, pageSize, orderBy, sortType, fileTypes: [2], resType: 1 });
  }

  fsDocumentList(page = 0, pageSize = 50, orderBy = 3, sortType = 1): Promise<ApiResponse<ListFilesData>> {
    return this.fsFiles({ parentId: "*", page, pageSize, orderBy, sortType, fileTypes: [4], resType: 1 });
  }

  fsRecycleFiles(page = 0, pageSize = 50, orderBy = 10, sortType = 0): Promise<ApiResponse<ListFilesData>> {
    return this.fsFiles({ page, pageSize, orderBy, sortType, dirType: 4 });
  }

  async fsDetail(fileId: string): Promise<ApiResponse<FileDetail>> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/get_file_detail`, { json: { fileId } });
  }

  async fsCreateDir(dirName: string, parentId?: number | string, failIfNameExist = false): Promise<ApiResponse> {
    const body: Record<string, unknown> = { dirName, parentId: parentId ?? "" };
    if (failIfNameExist) body.failIfNameExist = true;
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/create_dir`, { json: body });
  }

  async fsCopy(fileIds: string[], parentId?: number | string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/copy_file`, {
      json: { fileIds, parentId: parentId ?? "" },
    });
  }

  async fsMove(fileIds: string[], parentId?: number | string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/move_file`, {
      json: { fileIds, parentId: parentId ?? "" },
    });
  }

  async fsRename(fileId: string, newName: string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/rename`, {
      json: { fileId, newName },
    });
  }

  async fsDelete(fileIds: string[]): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/delete_file`, { json: { fileIds } });
  }

  async fsRecycle(fileIds: string[]): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/recycle_file`, { json: { fileIds } });
  }

  async fsClearRecycleBin(): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/clear_recycle_bin`);
  }

  async getTaskStatus(taskId: string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/get_task_status`, { json: { taskId } });
  }

  async downloadUrl(fileId: string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/get_res_download_url`, { json: { fileId } });
  }

  // ---------------------------------------------------------------- cloud download

  async cloudTaskList(page = 0, pageSize = 50, status?: number[]): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizcloudcollection.s/v1/list_task`, {
      json: { page, pageSize, status: status ?? [0, 1, 3, 4] },
    });
  }

  async cloudResolveUrl(url: string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizcloudcollection.s/v1/resolve_res`, { json: { url } });
  }

  async cloudResolveTorrent(torrent: string | Buffer): Promise<ApiResponse> {
    const data = typeof torrent === "string" ? readFileSync(torrent) : torrent;
    const form = new FormData();
    form.append(
      "torrent",
      new Blob([data as unknown as BlobPart], { type: "application/octet-stream" }),
      "file.torrent",
    );
    return this.request(`${API_BASE}/nd.bizcloudcollection.s/v1/resolve_torrent`, { body: form });
  }

  async cloudCreateTask(url: string, parentId?: number | string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizcloudcollection.s/v1/create_task`, {
      json: { url, parentId: parentId ?? "" },
    });
  }

  // ---------------------------------------------------------------- share

  async shareCreate(opts: {
    fileIds: string[];
    title: string;
    validateDuration?: number;
    shareType?: number;
    code?: string;
    autoFillCode?: boolean;
    trafficLimit?: string;
    maxRestoreCount?: number;
    downloadType?: number;
  }): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/share_file`, {
      json: {
        fileIds: opts.fileIds,
        title: opts.title,
        validateDuration: opts.validateDuration ?? 0,
        shareType: opts.shareType ?? 1,
        code: opts.code ?? "",
        autoFillCode: opts.autoFillCode ?? true,
        trafficLimit: opts.trafficLimit ?? "0",
        maxRestoreCount: opts.maxRestoreCount ?? 0,
        downloadType: opts.downloadType ?? 1,
      },
    });
  }

  async shareUserList(page = 0, pageSize = 50, orderType = 1, sortType = 1): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/get_share_list`, {
      json: { page, pageSize, orderType, sortType },
    });
  }

  async shareUpdate(opts: {
    shareId: string;
    title: string;
    validateDuration?: number;
    shareType?: number;
    code?: string;
    autoFillCode?: boolean;
    trafficLimit?: string;
    maxRestoreCount?: number;
    downloadType?: number;
  }): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/update_share`, {
      json: {
        id: opts.shareId,
        title: opts.title,
        validateDuration: opts.validateDuration ?? 0,
        shareType: opts.shareType ?? 1,
        code: opts.code ?? "",
        autoFillCode: opts.autoFillCode ?? true,
        trafficLimit: opts.trafficLimit ?? "0",
        maxRestoreCount: opts.maxRestoreCount ?? 0,
        downloadType: opts.downloadType ?? 1,
      },
    });
  }

  async shareDelete(ids: string[]): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/delete_share`, { json: { ids } });
  }

  async shareRestore(accessToken: string, fileIds: string[], parentId = ""): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/restore_share`, {
      json: { accessToken, fileIds, parentId },
    });
  }

  async shareDownloadUrl(fileId: string, accessToken: string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/get_share_download_url`, {
      json: { fileId, accessToken },
    });
  }

  async shareFilesSize(accessToken: string, fileIds: string[], download = true): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/get_share_files_size`, {
      json: { accessToken, fileIds, download },
    });
  }

  // ------------------------------------------------------- share (public)

  static async #publicPost(url: string, json: unknown, fetchImpl?: typeof fetch): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      did: generateDid(),
      dt: "4",
      origin: "https://www.guangyapan.com",
      referer: "https://www.guangyapan.com/",
      traceparent: generateTraceparent(),
      "user-agent": USER_AGENT,
    };
    const res = await (fetchImpl ?? fetch)(url, {
      method: "POST",
      headers,
      body: JSON.stringify(json),
    });
    if (!res.ok) throw new HttpError(res.status, await res.text());
    return (await res.json()) as ApiResponse;
  }

  static shareSummary(shareId: string): Promise<ApiResponse> {
    return GuangyaClient.#publicPost(
      `${API_BASE}/nd.bizuserres.s/v1/get_share_summary`,
      { shareId },
    );
  }

  static shareAccessToken(shareId: string, code: string): Promise<ApiResponse> {
    return GuangyaClient.#publicPost(
      `${API_BASE}/nd.bizuserres.s/v1/get_share_access_token`,
      { shareId, code },
    );
  }

  static shareFilesList(
    accessToken: string,
    opts: { parentId?: string; page?: number; pageSize?: number; orderBy?: number; sortType?: number } = {},
  ): Promise<ApiResponse> {
    return GuangyaClient.#publicPost(
      `${API_BASE}/nd.bizuserres.s/v1/get_share_page_files_list`,
      {
        accessToken,
        parentId: opts.parentId ?? "",
        page: opts.page ?? 1,
        pageSize: opts.pageSize ?? 50,
        orderBy: opts.orderBy ?? 0,
        sortType: opts.sortType ?? 0,
      },
    );
  }

  // ---------------------------------------------------------------- upload

  async uploadToken(
    name: string,
    fileSize: number,
    parentId?: number | string,
    md5?: string,
  ): Promise<ApiResponse<UploadTokenData>> {
    const res: Record<string, unknown> = { fileSize };
    if (md5) res.md5 = md5;
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/get_res_center_token`, {
      json: { capacity: 2, name, res, parentId: parentId ?? "" },
    });
  }

  async checkCanFlashUpload(taskId: string, filePath: string): Promise<ApiResponse<{ canFlashUpload?: boolean }>> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/check_can_flash_upload`, {
      json: { taskId, gcid: calculateGcid(filePath) },
    });
  }

  async uploadInfo(taskId: string): Promise<ApiResponse> {
    return this.request(`${API_BASE}/nd.bizuserres.s/v1/file/get_info_by_task_id`, {
      json: { taskId },
    });
  }

  async #pollUploadInfo(taskId: string, attempts = 10): Promise<ApiResponse> {
    for (let i = 0; i < attempts; i += 1) {
      const res = await this.uploadInfo(taskId);
      if (res.msg !== "文件上传中") return res;
      await sleep(2000);
    }
    return this.uploadInfo(taskId);
  }

  /**
   * Upload a local file. Files < 1 MB go through a single PUT; larger
   * files are chunked (5 MB parts). Returns the finalized upload info.
   */
  async fileUpload(
    filePath: string,
    opts: { name?: string; parentId?: number | string; contentType?: string; chunkSize?: number } = {},
  ): Promise<ApiResponse> {
    const size = statSync(filePath).size;
    const name = opts.name ?? basename(filePath);

    if (size < 1024 * 1024) {
      const md5 = createHash("md5").update(readFileSync(filePath)).digest("base64");
      const tokenRes = await this.uploadToken(name, size, opts.parentId, md5);
      const token = tokenRes.data;
      if (!token) throw new Error(`uploadToken failed: ${JSON.stringify(tokenRes)}`);
      await directPut(filePath, token, md5, { contentType: opts.contentType, fetchImpl: this.#fetch });
      return this.#pollUploadInfo(token.taskId);
    }

    const tokenRes = await this.uploadToken(name, size, opts.parentId);
    const token = tokenRes.data;
    if (!token) throw new Error(`uploadToken failed: ${JSON.stringify(tokenRes)}`);

    try {
      const flash = await this.checkCanFlashUpload(token.taskId, filePath);
      if (flash.data?.canFlashUpload) return this.uploadInfo(token.taskId);
    } catch {
      // flash check endpoint may reject; fall through to a real upload
    }

    await cdnUpload(filePath, token, {
      contentType: opts.contentType,
      chunkSize: opts.chunkSize,
      fetchImpl: this.#fetch,
    });
    return this.#pollUploadInfo(token.taskId);
  }
}

function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  return rl.question(prompt).finally(() => rl.close());
}