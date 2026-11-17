import { _electron as electron, expect, test, type ElectronApplication, type Frame } from '@playwright/test';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { keepElectronInBackground, terminateElectron } from '../../desktop/e2e/support/electronApp';

test('document fields in the real extension', async () => {
 test.skip(!process.env.EASYVIEW_CHECK_DOCX, '设置 EASYVIEW_CHECK_DOCX 为《技术规范书.docx》后再核对照封面、目录和保存');
 const temporary = await mkdtemp(join(tmpdir(), 'easyview-vscode-docx-')); const workspace = join(temporary,'workspace');
 await mkdir(workspace); await mkdir(join(temporary,'data','User'),{recursive:true});
 await writeFile(join(temporary,'data','User','settings.json'), JSON.stringify({'security.workspace.trust.enabled':false,'workbench.startupEditor':'none','workbench.editorAssociations':{'*.docx':'easyviewMd.filePreview'}}));
 const doc=join(workspace,'spec.docx'); await copyFile(process.env.EASYVIEW_CHECK_DOCX!,doc);
 const readXml=async()=> (await JSZip.loadAsync(await readFile(doc))).file('word/document.xml')!.async('string');
 const before=await readXml(); let app: ElectronApplication|undefined;
 try {
  app=await electron.launch({executablePath:process.env.VSCODE_EXECUTABLE_PATH,args:[`--user-data-dir=${join(temporary,'data')}`,`--extensions-dir=${join(temporary,'extensions')}`,`--extensionDevelopmentPath=${resolve(__dirname,'..')}`,'--disable-workspace-trust','--skip-welcome','--skip-release-notes',workspace,doc],timeout:60000});
  await keepElectronInBackground(app); const page=await app.firstWindow(); let frame:Frame|undefined;
  await expect.poll(async()=>{for(const f of page.frames()) if(await f.locator('.paged-editor__hidden-pm .ProseMirror').count()){frame=f;return true;}return false;},{timeout:60000}).toBe(true);
  const editor=frame!;
  const laidOutPages = editor.locator('.paged-editor__pages .layout-page');
  await expect(laidOutPages.first()).toContainText('浙江公司');
  await expect(laidOutPages.first()).not.toContainText('总则');
  await expect(laidOutPages.nth(1)).toContainText('总则');
  await expect(laidOutPages.nth(1).locator('.layout-run-tab').first()).toContainText('.');
  await expect(editor.locator('.paged-editor__pages')).toContainText('1、 总则');
  await expect(editor.locator('.paged-editor__pages')).toContainText('10、 其他要求');
  await expect(editor.locator('.paged-editor__hidden-pm .ProseMirror')).toContainText('其他要求',{timeout:30000});
  await editor.locator('.docx-editor__scroll-container').first().evaluate(el=>{el.scrollTop=1300}); await page.waitForTimeout(400);
  await page.screenshot({path:'/tmp/easyview-vscode-toc.png'});
  const cover=editor.locator('.paged-editor__pages .layout-paragraph',{hasText:'浙江公司'}).first(); await cover.scrollIntoViewIfNeeded(); await cover.click();
  await page.keyboard.press('End'); await page.keyboard.type('EASYVIEWEXTVERIFYXYZ');
  await editor.getByRole('button',{name:/^(保存|Save)$/}).first().click();
  await expect.poll(async()=> (await readXml()).includes('EASYVIEWEXTVERIFYXYZ'),{timeout:30000}).toBe(true);
  const after=await readXml(); for(const re of [/w:fldCharType="begin"/g,/w:fldCharType="end"/g,/HYPERLINK/g,/PAGEREF/g]) expect((after.match(re)??[]).length).toBe((before.match(re)??[]).length);
 } finally { if(app) await terminateElectron(app); await rm(temporary,{recursive:true,force:true}); }
});
