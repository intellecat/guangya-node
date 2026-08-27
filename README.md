# guangya

TypeScript client for the 光鸭云盘 (guangyapan) C-end API.

Pure Node — no runtime dependencies. Uses the global `fetch` (Node ≥ 18) and
the built-in `crypto`, `fs`, `net`, and `dns` modules. Implements SMS login,
file management, upload (single-PUT for small files, multipart for large),
download, sharing, and cloud-download tasks.

## Install

```sh
npm install guangya
```

Requires Node.js ≥ 18.

## Quick start

```ts
import { GuangyaClient } from "guangya";

// With an existing access token
const client = new GuangyaClient({ accessToken: "..." });

// Or via SMS login (reads the code from stdin by default)
const client = new GuangyaClient();
await client.loginSms("+86 13800138000");

// List files
const files = await client.fsFiles({ parentId: "*", pageSize: 50 });
for (const f of files.data?.list ?? []) {
  console.log(f.fileName, f.fileSize);
}

// Upload
const res = await client.fileUpload("/path/to/file.mp4");
console.log(res);
```

## API

### Auth

| Method | Description |
| --- | --- |
| `loginSms(phoneNumber, getCode?, target?)` | Full SMS login; `getCode` defaults to a stdin prompt |
| `loginSmsInit(phoneNumber)` | Start the verification flow, returns `captcha_token` |
| `loginSmsSend(phoneNumber, captchaToken)` | Dispatch the SMS |
| `loginSmsVerify(verificationId, code)` | Verify the code, returns `verification_token` |
| `loginSmsSignin({...})` | Exchange the code for an access token |
| `refreshToken()` | Refresh using the stored refresh token |
| `userInfo()` | Current account info |

`request()` auto-refreshes before expiry and retries once after a `401`.

### Files (`fs*`)

| Method | Description |
| --- | --- |
| `fsFiles(params)` | List files/dirs (`parentId: "*"` = all, `dirType: 4` = recycle bin) |
| `fsImageList()` / `fsVideoList()` / `fsDocumentList()` | Typed shortcuts |
| `fsRecycleFiles()` | Recycle-bin listing |
| `fsDetail(fileId)` | Metadata + media specs |
| `fsCreateDir(name, parentId?)` | Create a folder |
| `fsCopy(fileIds, parentId?)` / `fsMove(fileIds, parentId?)` | Copy / move |
| `fsRename(fileId, newName)` | Rename |
| `fsDelete(fileIds)` | Trash (or permanent-delete from the bin) |
| `fsRecycle(fileIds)` / `fsClearRecycleBin()` | Restore / empty bin |
| `getTaskStatus(taskId)` | Async task status |
| `downloadUrl(fileId)` | Signed download URL |

### Upload

| Method | Description |
| --- | --- |
| `fileUpload(path, opts?)` | Full pipeline: token → (flash check) → PUT or chunked CDN upload → poll |
| `uploadToken(name, size, parentId?, md5?)` | Get an OSS upload token |
| `checkCanFlashUpload(taskId, path)` | Dedupe check (may be rejected by the API) |
| `cdnUpload(path, token, opts?)` | 5 MB multipart upload to OSS, returns ETag |
| `uploadInfo(taskId)` | Poll an upload task |

Files **< 1 MB** are pushed with a single PUT (`directPut`); larger files use
multipart with 5 MB parts. The final result is the completed task info.

### Share

| Method | Description |
| --- | --- |
| `shareCreate({ fileIds, title, ... })` | Create a share |
| `shareUserList()` | List own shares |
| `shareUpdate({ shareId, title, ... })` | Update a share |
| `shareDelete(ids)` | Delete shares |
| `shareRestore(accessToken, fileIds, parentId?)` | Save shared files |

Public share helpers (no login) are static:

| Method | Description |
| --- | --- |
| `GuangyaClient.shareSummary(shareId)` | Share metadata |
| `GuangyaClient.shareAccessToken(shareId, code)` | Resolve a share token |
| `GuangyaClient.shareFilesList(accessToken, opts?)` | List a share's files |

### Cloud download

| Method | Description |
| --- | --- |
| `cloudTaskList(page, pageSize, status?)` | List cloud tasks |
| `cloudResolveUrl(url)` | Resolve HTTP/magnet/ed2k links |
| `cloudResolveTorrent(pathOrBuffer)` | Parse a `.torrent` |
| `cloudCreateTask(url, parentId?)` | Start a cloud download |

### Utilities

| Export | Description |
| --- | --- |
| `calculateGcid(path)` | Content hash used for dedupe |
| `generateDid()` / `generateTraceparent()` | Client/request identifiers |
| `FILE_TYPE` / `FILE_TYPE_NAME` | File-type enums |
| `ossSignHeaders(...)` | OSS v1 request signing (for custom OSS work) |

## Notes

- The account token in `gy_token.json` (project root) is a live session token
  from an SMS login; the client persists `access_token`/`refresh_token` and
  refreshes automatically.
- `checkCanFlashUpload` currently returns `112 参数错误`; `fileUpload`
  gracefully falls through to a real upload when that happens.
- The client forces IPv4-first DNS and disables happy-eyeballs at load, which
  is required in IPv6-unreachable environments (Node's default family-0
  connect times out there).

## Development

```sh
npm run build     # tsc → dist/
npm test          # compile tests + run node --test
npm run typecheck # strict type check of src + tests
```