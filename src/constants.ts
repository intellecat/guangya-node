export const FILE_TYPE = {
  图片: 1,
  视频: 2,
  音频: 3,
  文档: 4,
  压缩包: 5,
  BT种子: 9,
} as const;

export const FILE_TYPE_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(FILE_TYPE).map(([name, id]) => [id, name]),
);