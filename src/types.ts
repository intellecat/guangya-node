/** Standard envelope used by every guangyapan C-end endpoint. */
export interface ApiResponse<T = unknown> {
  code?: number;
  msg?: string;
  error?: string;
  error_code?: number;
  data?: T;
}

export interface OssCredentials {
  accessKeyID: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

export interface UploadTokenData {
  gcid: string;
  provider: number;
  creds: OssCredentials;
  endPoint: string;
  fullEndPoint: string;
  bucketName: string;
  objectPath: string;
  region: string;
  taskId: string;
  callbackVar?: string;
}

export interface UploadTokenResult extends ApiResponse<UploadTokenData> {}

export interface VideoSpec {
  resolution: { width: number; height: number };
  duration: number;
  bitRate: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string;
  videoType: string;
  defaultResolution?: boolean;
  resolutionName?: string;
  mimeType?: string;
}

export interface FileInfo {
  fileId: string;
  fileName: string;
  fileSize?: number;
  gcid?: string;
  md5?: string;
  depth?: number;
  mineType?: string;
  fileType?: number;
  dirType?: number;
  resType: number;
  ext?: string;
  parentId?: string;
  fullParentIds?: string;
  ctime?: number;
  utime?: number;
  auditStatus?: number;
  thumbnail?: string;
}

export interface FileDetail {
  fileInfo: FileInfo;
  location?: string;
  picInfo?: { width: number; height: number; previewUrl: string } | null;
  videoResource?: Array<{ gcid: string; info: VideoSpec }>;
}

export interface ListFilesParams {
  parentId?: number | string | null;
  page?: number;
  pageSize?: number;
  orderBy?: number;
  sortType?: number;
  fileTypes?: number[];
  resType?: number;
  dirType?: number;
  needPlayRecord?: boolean;
}

export interface ListFilesData {
  total: number;
  list: FileInfo[];
}

export interface SignInResult {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  sub?: string;
}

export interface SmsLoginSession {
  captchaToken: string;
  verificationId: string;
}