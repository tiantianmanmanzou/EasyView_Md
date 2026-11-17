import { defineMessages } from '@easyview/contracts/i18n';

export const tArchiveExtract = defineMessages({
  'zh-CN': {
    unsupported: '不支持解压该格式：{name}',
    unreadable: '无法读取压缩包：{message}',
    unsafePath: '压缩包包含不安全的路径，已停止解压：{path}',
    diskFull: '磁盘空间不足，已停止解压（需保留至少 {reserve} 可用空间）',
  },
  en: {
    unsupported: 'Extracting this format is not supported: {name}',
    unreadable: 'Cannot read the archive: {message}',
    unsafePath: 'The archive contains an unsafe path, so nothing was extracted: {path}',
    diskFull: 'Not enough disk space; extraction stopped (at least {reserve} must stay free)',
  },
});
