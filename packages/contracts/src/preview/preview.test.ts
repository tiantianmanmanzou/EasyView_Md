import { describe, expect, it } from 'vitest';
import {
  archiveExtractFolderName,
  extractableArchiveSuffix,
  isPreviewWritableFile,
  resolvePreviewChrome,
  resolvePreviewRoute,
  WRITABLE_PREVIEW_ROUTES,
} from './preview';

describe('archive extraction', () => {
  it('extracts zip-family and tar/gzip archives into a folder named after the archive', () => {
    expect(['资料.ZIP', 'a.jar', 'b.vsix', 'c.tar', 'd.tar.gz', 'e.tgz', 'f.txt.gz'].map(archiveExtractFolderName)).toEqual(['资料', 'a', 'b', 'c', 'd', 'e', 'f.txt']);
    expect(extractableArchiveSuffix('d.TAR.GZ')).toBe('.tar.gz');
    expect(['x.7z', 'x.rar', 'x.cbr', 'notes.md', '.zip'].map(extractableArchiveSuffix)).toEqual([null, null, null, null, null]);
  });
});

describe('preview routes', () => {
  it('keeps Markdown in the editor and routes supported preview formats', () => {
    expect(resolvePreviewRoute('notes.md')).toBeNull();
    expect(resolvePreviewRoute('rule.mdc')).toBeNull();
    expect(resolvePreviewRoute('clip.MP4')).toMatchObject({ route: 'video', mimeType: 'video/mp4' });
    expect(resolvePreviewRoute('clip.m4v')?.route).toBe('video');
    expect(resolvePreviewRoute('song.MP3')).toMatchObject({ route: 'audio', mimeType: 'audio/mpeg' });
    expect(resolvePreviewRoute('voice.m4a')).toMatchObject({ route: 'audio', mimeType: 'audio/mp4' });
    for (const name of ['a.wav', 'a.ogg', 'a.oga', 'a.flac']) expect(resolvePreviewRoute(name)?.route).toBe('audio');
    expect(resolvePreviewRoute('request.http')?.route).toBe('http');
    expect(resolvePreviewRoute('font.woff2')?.route).toBe('font');
    expect(resolvePreviewRoute('archive.tar.gz')?.route).toBe('archive');
    expect(resolvePreviewRoute('extension.vsix')?.route).toBe('archive');
    expect(resolvePreviewRoute('bundle.zip')?.route).toBe('archive');
    expect(resolvePreviewRoute('bundle.zip')?.maxSourceBytes).toBe(1024 * 1024 * 1024);
    expect(resolvePreviewRoute('flow.drawio')?.route).toBe('design');
    expect(resolvePreviewRoute('diagram.dio')?.route).toBe('design');
    expect(resolvePreviewRoute('map.xmind')?.route).toBe('design');
  });

  it('routes lightweight spreadsheet/text-table previews to spreadsheet (PDF-style chrome)', () => {
    expect(resolvePreviewRoute('table.csv')?.route).toBe('spreadsheet');
    expect(resolvePreviewRoute('table.tsv')?.route).toBe('spreadsheet');
    expect(resolvePreviewRoute('legacy.xls')?.route).toBe('spreadsheet');
    expect(resolvePreviewRoute('sheet.ods')?.route).toBe('spreadsheet');
    expect(resolvePreviewRoute('old.doc')?.route).toBe('word');
  });

  it('keeps HTML on the html route (not text)', () => {
    expect(resolvePreviewRoute('index.html')?.route).toBe('html');
    expect(resolvePreviewRoute('page.HTM')?.route).toBe('html');
  });

  it('routes common programming and config files to text', () => {
    for (const name of [
      'app.py', 'util.pyi', 'query.sql', 'main.ts', 'app.tsx', 'lib.mjs',
      'style.scss', 'main.go', 'lib.rs', 'App.kt', 'script.sh', 'tool.ps1',
      'Main.java', 'Component.vue', 'schema.graphql', 'main.tf', '.env',
      '.gitignore', '.dockerignore', 'config.toml', 'data.json', 'notes.yaml',
    ]) {
      expect(resolvePreviewRoute(name)?.route, name).toBe('text');
    }
  });

  it('routes well-known extensionless basenames to text', () => {
    for (const name of [
      'Dockerfile', 'Makefile', 'makefile', 'GNUmakefile', 'Jenkinsfile',
      'CMakeLists.txt', 'Gemfile', 'Podfile', 'Procfile', 'Vagrantfile',
      'path/to/Dockerfile',
    ]) {
      expect(resolvePreviewRoute(name)?.route, name).toBe('text');
    }
  });

  it('assigns a single chrome family per route (no heic/ppt basic forks)', () => {
    expect(resolvePreviewChrome('notes.md')).toBeNull();
    expect(resolvePreviewChrome('app.py')).toBe('basic');
    expect(resolvePreviewChrome('Dockerfile')).toBe('basic');
    expect(resolvePreviewChrome('page.html')).toBe('basic');
    expect(resolvePreviewChrome('clip.mp4')).toBe('basic');
    expect(resolvePreviewChrome('song.mp3')).toBe('basic');
    expect(resolvePreviewChrome('photo.png')).toBe('document');
    expect(resolvePreviewChrome('photo.heic')).toBe('document');
    expect(resolvePreviewChrome('photo.HEIF')).toBe('document');
    expect(resolvePreviewChrome('deck.pptx')).toBe('document');
    expect(resolvePreviewChrome('legacy.ppt')).toBe('document');
    expect(resolvePreviewChrome('doc.pdf')).toBe('document');
    expect(resolvePreviewChrome('sheet.xlsx')).toBe('document');
    expect(resolvePreviewChrome('letter.docx')).toBe('document');
    expect(resolvePreviewChrome('bundle.zip')).toBe('document');
    expect(resolvePreviewRoute('photo.heic')).toMatchObject({ route: 'image', chrome: 'document' });
    expect(resolvePreviewRoute('legacy.ppt')).toMatchObject({ route: 'powerpoint', chrome: 'document' });
  });

  it('exposes writable suffix info for the writeBytes route set', () => {
    expect([...WRITABLE_PREVIEW_ROUTES]).toEqual(['text', 'word', 'spreadsheet', 'image']);
    expect(isPreviewWritableFile('app.py')).toBe(true);
    expect(isPreviewWritableFile('Dockerfile')).toBe(true);
    expect(isPreviewWritableFile('letter.docx')).toBe(true);
    expect(isPreviewWritableFile('letter.dotx')).toBe(true);
    expect(isPreviewWritableFile('letter.doc')).toBe(false);
    expect(isPreviewWritableFile('letter.docm')).toBe(false);
    expect(isPreviewWritableFile('sheet.xlsx')).toBe(true);
    expect(isPreviewWritableFile('sheet.xlsm')).toBe(true);
    expect(isPreviewWritableFile('sheet.xls')).toBe(false);
    expect(isPreviewWritableFile('sheet.csv')).toBe(false);
    expect(isPreviewWritableFile('doc.pdf')).toBe(false);
    expect(isPreviewWritableFile('photo.png')).toBe(true);
    expect(isPreviewWritableFile('photo.JPEG')).toBe(true);
    expect(isPreviewWritableFile('photo.webp')).toBe(true);
    expect(isPreviewWritableFile('photo.gif')).toBe(false);
    expect(isPreviewWritableFile('photo.heic')).toBe(false);
    expect(isPreviewWritableFile('notes.md')).toBe(false);
  });
});
