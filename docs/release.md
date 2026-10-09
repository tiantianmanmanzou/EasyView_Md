# EasyView 桌面端发布

## 流程与版本来源

`.github/workflows/release.yml` 由推送 `v*` tag 触发，也支持手动输入已有 tag。发布版本必须是稳定版 `vX.Y.Z`，且去掉 `v` 后与该 tag 下的 `apps/desktop/package.json` 版本完全一致，否则在构建前失败。手动运行也只检出 `refs/tags/<tag>`，不能使用分支代替。

同一 matrix 在 `macos-14` 原生 arm64 和 `windows-latest` 原生 x64 上构建。构建后执行现有包内容检查与打包应用运行检查。聚合 job 生成校验与清单，再通过 `gh` 创建 Release，附件如下：

- `EasyView_Md-mac-arm64.dmg`
- `EasyView_Md-mac-arm64.zip`
- `EasyView_Md-win-x64-setup.exe`
- `EasyView_Md-win-x64.zip`
- `easyview-md.vsix`：VS Code / Cursor 扩展，版本见下文“VS Code 扩展（VSIX）”。
- `SHA256SUMS`：上述五个文件的 SHA-256。
- `release.json`：产品、tag、desktopVersion、extensionVersion，以及每个文件的文件名、大小和 SHA-256。

Release 先创建为草稿，上传完成后公开。失败重跑时，草稿继续上传；已公开的 Release 下载原始附件用于官网同步，不覆盖已发布的安装包。

公开后，用 SSH/rsync 上传四个安装包、`easyview-md.vsix` 和 `SHA256SUMS` 到 `/opt/services/sites/easyview/downloads/`，服务器执行 `sha256sum -c SHA256SUMS`，成功后上传 `release.json`。最后更新 `tiantianmanmanzou/WonderXY-ART` 的 `main`：只提交 `sites/easyview/index.html` 中桌面端两处版本文字、三条桌面下载链接的 `?v=` 参数，以及扩展卡片的版本文字和下载链接，由其现有 `deploy.yml` 自动部署。官网部署使用的 `--exclude 'downloads/'` 保留服务器上的下载文件。

所有桌面发布共用一个 concurrency 队列，避免同时写固定下载文件名。GitHub 不保证排队顺序，也可能替换尚未开始的 pending run；应等上一版完成再发下一版。手动重跑历史 tag 会把官网下载切回该版本，应只重跑准备对外提供的版本。固定下载路径逐文件替换，整组文件不是原子切换；同步失败时官网 HTML 不更新，但部分安装包可能已经替换，应及时重跑同步。

VSIX 随同一 tag 构建与发布，但扩展版本号独立维护。现有 Desktop Build 仅保留应用打包与运行验证，不制作发布安装包；旧 `desktop-release.yml` 已由新流程替代。

## VS Code 扩展（VSIX）

VSIX 与桌面端走同一条 Desktop Release 流程，但版本独立：tag 只对应桌面版本，扩展版本取自该 tag 下的 `apps/vscode-extension/package.json`（`version` job 输出 `extension_version`）。

- macOS 构建 job 在打完 dmg 后运行 `npm run package:vscode` 和 `npm run verify:vscode-package`，再用 `desktop-artifacts.mjs stage-vsix` 改名为固定文件名 `easyview-md.vsix`。VSIX 内含 node-pty 各平台预编译文件，与构建平台无关，只构建一次。
- `easyview-md.vsix` 与四个安装包一起进入 Release 附件、`SHA256SUMS`、`release.json`（新增 `extensionVersion` 字段）和服务器同步。
- 官网更新同时改写扩展卡片的 `vX.Y.Z · .vsix` 文字和 `easyview-md.vsix?v=X.Y.Z`（`data-easyview-extension-version` / `data-easyview-extension-download` 标记）。
- 扩展版本没变时也会重新打包并上传同版本 VSIX，内容来自该 tag 的源码。
- 本流程不发布到 VS Code Marketplace 或 Open VSX，商店发布仍需单独操作。

## GitHub Secrets

在 **EasyView_Md → Settings → Secrets and variables → Actions → Repository secrets** 配置：

| Secret | 用途 | 获取或生成方式 |
| --- | --- | --- |
| `EASYVIEW_DEPLOY_SSH_KEY` | 下载服务器 SSH 私钥 | 在可信机器使用 `ssh-keygen -t ed25519 -N '' -f <专用密钥路径>` 生成专用密钥；公钥由管理员加入部署账号 `authorized_keys`，私钥通过 GitHub 设置页面录入。不要放进仓库或日志。 |
| `EASYVIEW_DEPLOY_HOST` | 服务器域名或 IPv4 地址 | 由服务器管理员提供，不带协议或端口。 |
| `EASYVIEW_DEPLOY_USER` | SSH 部署账号 | 使用能写下载目录、执行 `mkdir` 和 `sha256sum` 的账号，由管理员配置目录权限。 |
| `EASYVIEW_DEPLOY_PORT` | SSH 端口 | 管理员提供的数字端口，需显式配置。 |
| `EASYVIEW_DEPLOY_KNOWN_HOSTS` | 固定可信服务器主机公钥，启用严格主机校验 | 管理员提供并通过可信渠道核对服务器主机密钥及指纹；保存 OpenSSH known_hosts 格式。非 22 端口的主机字段应是 `[host]:port`。不要把未经核验的扫描结果当作可信依据。 |
| `WONDERXY_ART_TOKEN` | 检出官网仓库、提交并推送其 main，触发部署 | GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens；Resource owner 选 `tiantianmanmanzou`，仅授权 `WonderXY-ART`，Repository permissions 的 **Contents: Read and write**，Metadata 使用默认读取。设置有效期并及时轮换。Token 所属账号须有该仓库写权限。 |

`GITHUB_TOKEN` 由 Actions 自动提供，无需手动创建。发布 job 声明 `contents: write`，用于 EasyView Release；其他 job 使用读取权限。跨仓库推送使用独立 PAT，不能用 EasyView 的 `GITHUB_TOKEN` 代替。PAT 推送可以触发官网 `push` 工作流，参见 [GitHub 工作流触发说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。

WonderXY-ART 原有部署 secrets 仍需有效：`DEPLOY_SSH_KEY`、`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_PORT`、`DEPLOY_PATH`。这些是官网部署的配置，不由 EasyView secrets 自动传递。无需改动原部署工作流。

两个仓库必须启用 Actions。官网 `main` 的分支保护/规则必须允许 token 所属账号直接推送这个页面更新；要求全部变更经 PR 审核的规则会使自动 push 失败，需由管理员决定如何授权。服务器需安装 `rsync` 和 `sha256sum`，部署账号需能写目标目录。Workflow 不包含代码签名或 Apple notarization；需要签名发布时，应另行配置证书和对应流程。

## 首次启用

先提交并推送 WonderXY-ART 的脚本与页面标记修改到 `main`，再提交并推送 EasyView 的发布改造，配置上述 secrets，然后发 tag。新流程运行时会读取官网 `main` 中的脚本，因此顺序不能颠倒。手动运行需要新 workflow 已存在于 EasyView 默认分支。

## 以后发版的三步操作

1. 完成变更并确定桌面版本。用 `npm version X.Y.Z --workspace @easyview/desktop --no-git-tag-version` 更新桌面 package 与锁文件，检查 diff 后提交；扩展需要发新版时，另行修改 `apps/vscode-extension/package.json` 的版本并一起提交。将对应提交推送到主分支。
2. 在要发布的提交上创建 tag：`git tag vX.Y.Z`。
3. 推送这个 tag：`git push origin vX.Y.Z`。

随后检查 EasyView 的 **Desktop Release** 运行成功、GitHub Release 附件齐全、WonderXY-ART 的 **Deploy** 成功，以及官网版本文字和下载文件校验值一致。主分支推送本身只执行日常 CI，不创建 Release。

## 手动重跑

- 在 Actions → Desktop Release → 对应运行中使用 **Re-run failed jobs**。失败在官网同步/推送时会重跑 publish job，复用已上传构建 artifacts 和已公开 Release。构建 artifacts 过期时，使用完整重跑。
- 使用 **Run workflow**，选择含新 workflow 的默认分支，输入已有 tag（例如 `vX.Y.Z`）。流程仍从该 tag 检出并校验版本，重新构建；已公开 Release 附件复用原文件。
- 如果 EasyView 已成功，而官网 Deploy 失败，直接在 WonderXY-ART Actions 重跑 Deploy 或使用其 Run workflow。官网 HTML 已是目标版本时 EasyView 不会生成空提交，也不会通过空提交重复触发部署。
- 官网 main 在发布期间发生并发修改，普通 push 可能被拒绝；工作流不强推。重跑 publish 会重新检出 main 并更新目标字段。

已有历史 Release（如 v2.0.1，没有 VSIX）若缺少本流程的固定文件名附件、`release.json` 或 `SHA256SUMS`，校验会失败；应使用新的未发布版本 tag，或先由维护者单独处理历史 Release 的附件。不要移动已发布 tag。Release 创建使用 [`gh release create --verify-tag`](https://cli.github.com/manual/gh_release_create)，防止自动创建未存在的 tag。

## 本地检查与脚本接口

所有目录都显式传入，CI 输出放在 runner 工作目录，不写官网仓库的 `sites/easyview/downloads/`。

```bash
node tooling/release/desktop-artifacts.mjs validate vX.Y.Z
node tooling/release/desktop-artifacts.mjs stage-vsix <固定文件名产物目录>
bash ../WonderXY-ART/scripts/prepare-easyview-downloads.sh <固定文件名产物目录> X.Y.Z <临时输出目录> --extension-version A.B.C --dry-run
bash ../WonderXY-ART/scripts/prepare-easyview-downloads.sh <固定文件名产物目录> X.Y.Z <临时输出目录> --extension-version A.B.C
node ../WonderXY-ART/scripts/easyview-release.mjs verify <临时输出目录> X.Y.Z [--extension-version A.B.C]
bash ../WonderXY-ART/scripts/sync-easyview-downloads.sh <临时输出目录> X.Y.Z --dry-run
node ../WonderXY-ART/scripts/easyview-release.mjs update-site <index.html副本> X.Y.Z --extension-version A.B.C --dry-run
```

prepare 的 dry-run 验证五个源文件存在且非空，不创建输出目录。sync 的 dry-run 验证清单和五个文件的大小、SHA-256 与版本，不读取密钥、不执行 SSH 或 rsync。update-site 的 dry-run 验证桌面端两处文字、三条链接以及扩展的一处文字、一条链接标记存在，不写文件。缺失、空文件、校验不符或页面标记数量异常会立即失败。
