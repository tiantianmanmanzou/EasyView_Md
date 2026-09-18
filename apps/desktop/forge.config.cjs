const path = require('node:path');
const { MakerSquirrel } = require('@electron-forge/maker-squirrel');
const { MakerZIP } = require('@electron-forge/maker-zip');

module.exports = {
  packagerConfig: {
    asar: { unpack: '**/node_modules/node-pty/**/*' },
    prune: false,
    extraResource: [path.resolve(__dirname, 'resources/java-decompiler')],
    name: 'EasyView_Md',
    appBundleId: 'com.easyview.md',
    icon: path.resolve(__dirname, 'assets/icon'),
    extendInfo: {
      CFBundleDisplayName: 'EasyView_Md',
      CFBundleName: 'EasyView_Md',
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Markdown Document',
          CFBundleTypeRole: 'Editor',
          LSHandlerRank: 'Alternate',
          CFBundleTypeExtensions: ['md', 'markdown', 'mdx'],
        },
      ],
    },
  },
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [
    new MakerZIP({}, ['darwin', 'win32']),
    new MakerSquirrel(
      {
        name: 'easyview_md',
        authors: 'EasyView_Md',
        description: 'EasyView_Md Markdown Editor',
      },
      ['win32'],
    ),
  ],
};
