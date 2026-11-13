import { defineMessages } from '@easyview/contracts/i18n';

export const tPreview = defineMessages({
  'zh-CN': {
    'unsupportedType': '当前文件类型不在 EasyView 一期预览范围内。',
    'desktopOnlyType': '「{route}」预览仅支持 EasyView 桌面版（插件侧未提供该宿主能力）。',
    'readFileFailed': '无法读取预览文件。',
    'fileTooLarge': '文件超过 {size} MiB 的 {route} 预览上限。',
    'readTextFailed': '文本读取失败',
    'writeUnsupported': '当前文件不支持写入保存',
    'writeInvalid': '写入内容无效',
    'writeTooLarge': '写入内容超过 {size} MiB 上限',
    'saveTableFailed': '表格保存失败',
    'vscodeApiUnavailable': 'VS Code API 不可用',
    'extractFailed': '压缩包解压失败',
    'extractLocalOnly': '只能解压本地磁盘上的压缩包',
  },
  en: {
    'unsupportedType': 'This file type is not supported by EasyView preview yet.',
    'desktopOnlyType': '“{route}” preview is available only in EasyView Desktop (this extension host does not provide it).',
    'readFileFailed': 'Could not read the preview file.',
    'fileTooLarge': 'The file exceeds the {size} MiB {route} preview limit.',
    'readTextFailed': 'Failed to read text',
    'writeUnsupported': 'This file does not support saving',
    'writeInvalid': 'The content to write is invalid',
    'writeTooLarge': 'The content to write exceeds the {size} MiB limit',
    'saveTableFailed': 'Failed to save the spreadsheet',
    'vscodeApiUnavailable': 'VS Code API is unavailable',
    'extractFailed': 'Failed to extract the archive',
    'extractLocalOnly': 'Only archives on the local disk can be extracted',
  },
});
