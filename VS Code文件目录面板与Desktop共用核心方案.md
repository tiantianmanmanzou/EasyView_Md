# VS Code 文件目录面板与 Desktop 共用核心方案

- 评估日期：2026-09-17
- 项目目录：`/Users/zhangxy/GenAI/EasyView_Md`
- 适用产品：EasyView_Md Desktop、EasyView_Md VS Code/Cursor Extension
- 参考基线：Microsoft VS Code `a2f67035d5efaf16675905671a66593289e7f166`（2026-09-16）

## 1. 建设结论

本功能可实现，但应明确区分“共享业务逻辑”和“共享界面实现”：

- 文件节点模型、路径规则、排序、创建、重命名、删除、缓存失效和能力判断由公共核心统一实现。
- Desktop 使用自有 DOM 目录树、标签栏、编辑器分组和 Electron 窗口。
- Extension 使用 VS Code 原生 Tree View、编辑器标签、编辑器分组和窗口能力。
- 不在 Extension 中复制 VS Code 已经提供的标签栏右键命令。
- 不把 Desktop 的 `WorkspaceExplorer`、`TabController` 直接搬入 Extension。
- 不把 VS Code 私有 `IExplorerService`、`IClipboardService` 或 Workbench 内部类复制进项目。

目录树及文件右键能力属于中等范围增量开发；Desktop 的四方向拆分和“Move into New Window”属于重大架构调整，不能作为标签栏菜单的局部补丁实现。

## 2. VS Code Explorer 参考结论

参考源码：

- [`explorerModel.ts`](https://github.com/microsoft/vscode/blob/a2f67035d5efaf16675905671a66593289e7f166/src/vs/workbench/contrib/files/common/explorerModel.ts)
- [`explorerService.ts`](https://github.com/microsoft/vscode/blob/a2f67035d5efaf16675905671a66593289e7f166/src/vs/workbench/contrib/files/browser/explorerService.ts)
- [`explorerView.ts`](https://github.com/microsoft/vscode/blob/a2f67035d5efaf16675905671a66593289e7f166/src/vs/workbench/contrib/files/browser/views/explorerView.ts)
- [`explorerViewer.ts`](https://github.com/microsoft/vscode/blob/a2f67035d5efaf16675905671a66593289e7f166/src/vs/workbench/contrib/files/browser/views/explorerViewer.ts)
- [`fileActions.contribution.ts`](https://github.com/microsoft/vscode/blob/a2f67035d5efaf16675905671a66593289e7f166/src/vs/workbench/contrib/files/browser/fileActions.contribution.ts)
- [`editor.contribution.ts`](https://github.com/microsoft/vscode/blob/a2f67035d5efaf16675905671a66593289e7f166/src/vs/workbench/browser/parts/editor/editor.contribution.ts)

VS Code Explorer 的核心模式是：

```text
ExplorerModel
  └─ 维护根节点、节点身份、父子关系和已解析子节点

ExplorerService
  ├─ 执行文件操作
  ├─ 处理文件系统事件
  ├─ 增量修改 Model
  └─ 通知 View 刷新受影响节点

ExplorerView / ExplorerViewer
  ├─ 树渲染
  ├─ 焦点与选择
  ├─ 展开状态
  ├─ 上下文菜单
  └─ 键盘交互
```

本项目应复用以上职责划分，而不是复制 VS Code 源码：

1. **Model 不依赖界面。** 节点身份、父子关系和加载状态不应存放在 DOM 元素或 `TreeItem` 中。
2. **文件操作通过 Service 统一执行。** 创建、重命名和删除成功后先更新模型，再刷新受影响父节点。
3. **只刷新受影响节点。** 不因单个文件变化重建整棵树。
4. **编辑状态期间不刷新节点。** 避免重命名输入或新建输入被文件监听事件打断。
5. **右键目标与选择一致。** 右键未选中节点时先将该节点设为当前选择，再执行菜单动作。
6. **命令按能力显示。** 文件/目录、只读、本地/远程、是否属于工作区等条件决定菜单项是否可用。
7. **打开行为与编辑器状态分离。** 目录树只产生打开意图，具体由宿主决定使用 EasyView、VS Code 编辑器或系统默认应用。
8. **稳定节点 ID。** 刷新后继续保持展开、选择和当前文件定位。

## 3. 当前实现与目标架构差异

### 3.1 目录树

当前实现：

- Desktop 与 Extension 共用 `@easyview/node-runtime` 的 `WorkspaceTreeModel`、`WorkspaceFileOperationService` 与路径策略。
- Extension 通过 `VscodeWorkspaceGateway` 接入；Desktop 通过 `LocalWorkspaceGateway` + `DesktopWorkspaceCore` 接入。
- Desktop 仍保留自有 DOM 目录树、复制粘贴与 Electron trash/open/reveal；Extension 仍使用 VS Code TreeView 与 WorkspaceEdit。
- 图标映射共用 `@easyview/contracts` 的 `resolveWorkspaceTreeIcon`。

目标态已落地：业务核心统一，宿主只保留 Gateway、菜单与渲染 Adapter。

### 3.2 Desktop 标签与窗口

当前 Desktop：

- `DesktopTabRegistry` 只有一个全局标签数组和一个 `activeTabId`。
- `ActiveViewController` 明确只管理一个中央编辑器/预览 Surface。
- `editor-core` 使用模块级 `activeEditorInstance`，同一 Renderer 只允许一个编辑器实例。
- Main 进程使用单个 `mainWindow`、全局 `tabRegistry` 和全局 `documentSessions`。

因此以下操作不能通过增加右键菜单直接实现：

- Split Up
- Split Down
- Split Left
- Split Right
- Move into New Window

必须先完成多编辑器实例、编辑器分组、布局树和多窗口会话改造。

### 3.3 Extension 标签

当前 Extension 已设置：

```ts
supportsMultipleEditorsPerDocument: true
```

VS Code 原生标签右键菜单已经提供：

- Close
- Close Others
- Close All
- Copy Path
- Copy Relative Path
- Split Up
- Split Down
- Split Left
- Split Right
- Move into New Window

Extension 不新增同名命令，不向 `editor/title/context` 重复注入菜单。只需对 EasyView Custom Editor 做实际回归，确认拆分、移动窗口、关闭和路径复制均正常。

## 4. 公共 Workspace 核心

### 4.1 公共契约

在 `@easyview/contracts` 定义：

```ts
interface WorkspaceRootDescriptor {
  id: string;
  name: string;
}

interface WorkspaceNode {
  id: string;
  rootId: string;
  relativePath: string;
  name: string;
  kind: 'directory' | 'file' | 'symlink';
  capabilities: WorkspaceNodeCapabilities;
}

interface WorkspaceNodeCapabilities {
  openPreview: boolean;
  openExternal: boolean;
  revealInFileManager: boolean;
  copyPath: boolean;
  copyRelativePath: boolean;
  rename: boolean;
  delete: boolean;
}

interface WorkspaceGateway {
  readChildren(rootId: string, relativePath: string): Promise<WorkspaceNode[]>;
  create(rootId: string, request: WorkspaceCreateRequest): Promise<WorkspaceNode>;
  rename(rootId: string, relativePath: string, newName: string): Promise<WorkspaceNode>;
  delete(rootId: string, relativePath: string, options: WorkspaceDeleteOptions): Promise<void>;
}
```

真实本地路径或 VS Code `Uri` 由 Gateway 内部维护，不进入公共业务模型。

### 4.2 `WorkspaceTreeModel`

统一负责：

- 根节点及按 ID 查询。
- 父子关系和已加载子节点。
- 目录优先、文件名自然排序。
- 隐藏文件展示规则。
- 符号链接作为叶子节点，不递归进入目标。
- 当前选择节点。
- 节点加载中、加载成功和加载失败状态。
- 创建、重命名、删除后的局部模型更新。
- 文件系统变化后的受影响父节点计算。
- 当前文件的祖先链计算。

展开状态、滚动位置和菜单界面仍由各宿主保存。

### 4.3 `WorkspaceFileOperationService`

统一负责：

- 校验文件名不能为空、不能为 `.`/`..`、不能包含路径分隔符。
- 禁止路径逃逸工作区。
- 禁止覆盖同名节点。
- 创建、重命名和删除的单一调用入口。
- 操作成功后更新 Model 并发布结构变化事件。
- 操作失败时返回明确错误，不静默刷新或吞掉异常。
- 编辑中的临时节点不被文件监听刷新打断。

### 4.4 宿主 Gateway

#### Desktop

`LocalWorkspaceGateway` 使用：

- `node:fs`
- `node:path`
- Electron `shell.trashItem`
- Electron `shell.openPath`
- Electron `shell.showItemInFolder`

#### Extension

`VscodeWorkspaceGateway` 使用：

- `vscode.workspace.fs`
- `vscode.WorkspaceEdit`
- `vscode.workspace.applyEdit`
- `vscode.FileSystemWatcher`
- `vscode.env.openExternal`

Extension 的重命名和删除优先使用 `WorkspaceEdit`，使操作进入 VS Code 文件操作生命周期，而不是直接绕过宿主调用本地 `fs`。

## 5. 左侧目录树

### 5.1 Desktop 模式

保留现有左侧自定义目录树外观，内部改为：

```text
WorkspaceExplorerView
  → WorkspaceTreeController
  → WorkspaceTreeModel
  → WorkspaceFileOperationService
  → LocalWorkspaceGateway
```

交互规则：

- 单击目录：展开或收起。
- 单击文件：按现有规则在 EasyView 内打开。
- 当前标签变化：自动展开祖先目录并选中对应文件。
- 文件系统变化：只失效和刷新受影响父目录。
- 右键未选中节点：先选择该节点，不触发打开。
- 删除后：选择同级下一节点；没有下一节点时选择上一节点或父目录。

### 5.2 Extension 模式

新增独立 Activity Bar View Container：

- View Container：`easyviewMd-workspacePanel`
- Tree View：`easyviewMd.workspaceFiles`

使用 `vscode.window.createTreeView`：

- `WorkspaceTreeDataProvider` 负责节点到 `TreeItem` 的转换。
- `TreeItem.id` 使用稳定节点 ID。
- `TreeItem.resourceUri` 用于文件图标、文件装饰和资源上下文。
- 实现 `getParent()`，支持当前文件自动定位。
- 设置 `canSelectMany: false`，首期只支持单文件操作。
- `view/item/context` 只注册本目录树的文件菜单。

工作区根规则：

- 单根工作区始终显示该根目录。
- 多根工作区只显示当前活动文件所属根目录。
- 当前活动文件不属于任何根时显示明确空状态。
- 不允许在面板内另选一套独立目录。

## 6. 文件与文件夹右键菜单

### 6.1 菜单结构

文件 / 符号链接节点：

```text
Open Preview
Open With...
──────────────
Open with Default Application
Reveal in Finder / Reveal in File Explorer / Open Containing Folder
──────────────
Copy
Paste
Copy Path
Copy Relative Path
──────────────
Rename
Delete
```

`Open With...` 对齐 VS Code Explorer 的 `explorer.openWith`（`EditorResolution.PICK`）：

- Extension：优先调用 `explorer.openWith`；不可用时回退到编辑器 QuickPick（含 EasyView_Md / Text Editor）。
- Desktop：弹出可选打开方式（EasyView Editor / Preview / Default Application / Choose Application…）。

文件夹节点（与 Desktop 一致，不含打开类命令）：

```text
Reveal in Finder / Reveal in File Explorer / Open Containing Folder
──────────────
Copy
Paste
Copy Path
Copy Relative Path
──────────────
Rename
Delete
```

菜单名称根据操作系统显示：

- macOS：`Reveal in Finder`
- Windows：`Reveal in File Explorer`
- Linux：`Open Containing Folder`

### 6.2 Open Preview

Desktop：

- Markdown 使用 EasyView 编辑器打开。
- 非 Markdown 使用 Desktop 现有多格式 Preview 路由打开。
- 同一路径已打开时激活现有标签，不创建重复标签。

Extension：

- Markdown 调用现有 `easyviewMd.openEditor`。
- 其他文件调用 `vscode.open`，使用 VS Code 预览方式打开。
- 不把 Desktop 的多格式 Preview Viewer 复制进 Extension。

### 6.3 Open with Default Application

Desktop：调用 `shell.openPath`。

Extension：仅本地 `file:` URI 显示，调用 `vscode.env.openExternal`。

### 6.4 Reveal in Finder

Desktop：调用 `shell.showItemInFolder`。

Extension：仅本地 `file:` URI 显示，调用 VS Code 的文件系统定位命令。

Remote 或虚拟文件系统节点不显示本地系统操作。

### 6.5 Copy Path

- Desktop 复制标准化绝对路径。
- Extension 本地资源复制 `uri.fsPath`，Remote/虚拟资源复制完整 URI。
- 使用宿主文本剪贴板接口。

### 6.6 Copy Relative Path

- 相对当前目录树根计算。
- 统一使用 `/` 分隔符。
- 节点不属于当前根时不显示该命令。

### 6.7 Rename

Desktop：

- 目录树中进入内联编辑状态。
- 调用共享 `WorkspaceFileOperationService.rename`。
- 同步更新目录节点、打开标签、DocumentSession、PreviewSession 和持久化状态。
- 已打开且未保存的 Markdown 文件重命名时保留内容和 dirty 状态。

Extension：

- Tree View 不提供自定义内联编辑行，使用 `showInputBox` 输入新名称。
- 使用 `WorkspaceEdit.renameFile` 和 `workspace.applyEdit`。
- 操作成功后由文件事件刷新节点并重新定位当前编辑器。

### 6.8 Delete

Desktop：

- 本地文件调用 `shell.trashItem`，删除到系统回收站。
- 文件已打开且未保存时先显示“保存 / 不保存 / 取消”。
- 删除成功后关闭关联标签、DocumentSession 和 PreviewSession。

Extension：

- VS Code Extension 公共 API 不提供与内置 Explorer 完全等价的“移动到系统回收站”接口。
- 使用 `WorkspaceEdit.deleteFile` 或文件系统 Provider 的删除能力，执行前必须明确提示该操作可能是永久删除。
- 只读节点不显示 Delete。
- 不调用内置 Explorer 的私有 `moveFileToTrash` 命令冒充公共能力。

快捷键：

- Windows/Linux：`Delete`
- macOS：`Cmd+Backspace`，`Delete` 作为辅助按键
- 仅当目录树拥有焦点、当前节点为文件且不处于输入状态时生效。
- 不得在 Markdown 编辑器或重命名输入框中拦截删除键。

### 6.9 Copy 的能力边界

VS Code 原生 Explorer 的 `Copy` 将资源 URI 写入 VS Code 私有的 `code/file-list` 剪贴板，并与 `Paste` 配套使用。Extension API 没有公开等价的资源剪贴板接口，不能从自定义 Tree View 可靠复用该私有实现。

因此本项存在产品语义冲突：

- 如果 `Copy` 指“复制文件资源，随后可粘贴文件”，必须同时增加 `Paste` 及公共 `WorkspaceResourceClipboard`，才能形成完整闭环。
- 如果只复制文件路径，则会与 `Copy Path` 重复，不应保留两个菜单项。
- 不使用 VS Code 私有服务、内部命令或 macOS/Windows 专属脚本伪造跨平台能力。

本方案保留 `Copy` 菜单位置，但其最终语义必须在实施前确认；未确认前不得以复制路径冒充文件复制。

## 7. 标签栏右键菜单

### 7.1 菜单结构

```text
Close
Close Others
Close All
──────────────
Copy Path
Copy Relative Path
──────────────
Split & Move
  ├─ Split Up
  ├─ Split Down
  ├─ Split Left
  └─ Split Right
──────────────
Move into New Window
```

与 VS Code 一致，四个方向拆分放入 `Split & Move` 子菜单，避免顶层菜单过长。

### 7.2 命令语义

- `Close`：关闭右键目标标签。
- `Close Others`：关闭目标标签所在 Group 中的其他标签。
- `Close All`：关闭目标标签所在 Group 中的全部标签。
- `Copy Path`：复制标签对应文件的绝对路径或 URI。
- `Copy Relative Path`：复制相对工作区根路径；不在根目录内时隐藏。
- `Split Up/Down/Left/Right`：在指定方向创建 Group，并在新 Group 打开同一 Editor Input。
- `Move into New Window`：将标签从当前 Group 移出，在新的应用窗口中继续显示；不是复制标签。

关闭多个标签时，对未保存文档使用一次聚合确认，不连续弹出多个无关联对话框。

### 7.3 Extension 模式

全部使用 VS Code 原生标签栏菜单与命令：

- 不注册重复菜单项。
- 不重写关闭、拆分和窗口迁移逻辑。
- 保持 `supportsMultipleEditorsPerDocument: true`。
- 只增加自动化和人工回归，确认 EasyView Custom Editor 在多个 Group 和新窗口中工作正常。

### 7.4 Desktop 模式

Desktop 通过 Electron 原生 `Menu.popup()` 展示标签菜单，Renderer 只传递目标 `tabId` 和触发位置，Main 根据当前状态生成可用项。

不得在 DOM 中维护另一套菜单启用规则。

## 8. Desktop 多 Group 与多窗口整改

### 8.1 工作台模型

将单一标签数组升级为：

```ts
interface DesktopWorkbenchState {
  windows: DesktopWindowState[];
}

interface DesktopWindowState {
  id: string;
  groups: DesktopEditorGroup[];
  activeGroupId: string;
  layout: DesktopGroupLayoutNode;
}

interface DesktopEditorGroup {
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}
```

布局使用二叉布局树：

- 左/右拆分生成水平节点。
- 上/下拆分生成垂直节点。
- 关闭空 Group 后压缩无效布局节点。

### 8.2 Editor Input 与 View 分离

同一文件拆分后必须共享一个文档状态，但拥有多个视图状态：

```text
DocumentSession
  ├─ 文件路径
  ├─ 内容与 dirty 状态
  ├─ 保存与外部变化监听
  └─ 多个 EditorSurface
       ├─ Group / Window 位置
       ├─ 光标与选区
       ├─ 滚动位置
       └─ 局部 UI 状态
```

规则：

- 一个资源只有一个 `DocumentSession`。
- 每个 Split 创建新的 `EditorSurface`。
- 任一 Surface 编辑后更新公共内容，并向其他 Surface 广播，携带 `originSurfaceId` 防止回环。
- 只有最后一个 Surface 关闭时才释放 DocumentSession。
- dirty、保存、外部文件冲突和 Git 状态在所有 Surface 中一致。

### 8.3 `editor-core` 多实例前置改造

必须先完成：

- 删除模块级 `activeEditorInstance` 单例限制。
- 所有编辑器 DOM 查询限定在实例容器内。
- Toast、标题目录回调、表格偏好等模块级可变状态改为实例状态或依赖注入。
- 每个实例拥有独立 Host Transport、EditorView、CodeMirror、工具栏和面板生命周期。
- 一个实例销毁不得清理其他实例的事件和全局状态。

未完成该改造前，不实施 Desktop Split 菜单。

### 8.4 多窗口

新增 `DesktopWindowManager`：

- 使用 `Map<windowId, DesktopWindowSession>` 管理 BrowserWindow。
- IPC 根据 `event.sender.id` 路由到所属 WindowSession。
- 每个窗口拥有独立 Group、活动标签、目录树可见状态和菜单状态。
- 文档内容通过公共 DocumentSession 管理。
- `Move into New Window` 创建窗口、转移目标标签和 Surface，成功后再从源 Group 移除。
- dirty 内容、光标、滚动位置和 Preview 状态在转移过程中不得丢失。
- 窗口与 Group 状态进入新的持久化结构，并提供旧单窗口状态到新结构的一次性迁移。

## 9. 文件事件与增量刷新

参考 VS Code，采用以下策略：

- 监听事件防抖合并。
- 新增：父目录已加载且模型中不存在节点时刷新父目录。
- 重命名：直接更新节点名称、路径和索引，再刷新原父目录。
- 跨目录移动：同时刷新原父目录和新父目录。
- 删除：从模型移除节点，修正选择并刷新父目录。
- 当前存在新建或重命名输入时暂存文件事件，编辑完成后统一处理。
- Extension 窗口重新获得焦点时执行一次轻量刷新，补偿远程 Provider 或系统漏事件。
- 不对每次文件事件重新读取所有已展开目录。

## 10. 实施阶段

### 阶段一：共享目录核心与 Extension 面板

- 建立公共 Workspace 契约、Model、OperationService 和 Gateway。
- Desktop 目录树迁移到公共核心，视觉与既有行为保持不变。
- 新增 Extension Activity Bar Tree View。
- 完成 Open Preview、系统打开、文件管理器定位、路径复制、重命名和删除。
- 完成当前文件定位和增量刷新。

### 阶段二：基础标签菜单

Desktop 实现：

- Close
- Close Others
- Close All
- Copy Path
- Copy Relative Path

Extension 只验证原生菜单，不重复开发。

### 阶段三：Desktop 多实例与多 Group

- `editor-core` 多实例化。
- `DocumentSession` 与 `EditorSurface` 分离。
- Group 布局树。
- Split Up/Down/Left/Right。

该阶段属于重大架构调整，必须独立设计、独立测试，不与目录树增量功能混在一个修改批次。

### 阶段四：Desktop 多窗口

- `DesktopWindowManager`。
- IPC 窗口路由。
- Move into New Window。
- 多窗口持久化与恢复。

## 11. 测试与验收

### 11.1 公共 Workspace 核心

- 目录优先及自然排序。
- 隐藏文件展示。
- 路径逃逸、同名、非法名称拒绝。
- 符号链接不递归。
- 创建、重命名、删除只刷新受影响父节点。
- 编辑状态期间文件事件不破坏输入。
- 删除后选择位置正确。

### 11.2 文件右键菜单

Desktop 与 Extension 分别验证：

- 菜单只在文件节点出现。
- 只读节点隐藏 Rename/Delete。
- Remote 节点隐藏本地系统操作。
- Open Preview 路由正确。
- Copy Path 与 Copy Relative Path 内容正确。
- Rename 后打开标签、当前文件和目录树同步。
- 删除未保存文件时可保存、不保存或取消。
- Delete 快捷键只在目录树焦点下生效。

### 11.3 标签菜单

- 右键非活动标签时命令作用于右键目标，不误用当前活动标签。
- Close Others/Close All 的范围是当前 Group。
- dirty 文档关闭确认完整。
- Split 四方向布局和目标 Group 正确。
- 同一 Markdown 在两个 Surface 编辑时内容同步且无消息回环。
- 关闭一个 Surface 不释放仍被引用的 DocumentSession。
- Move into New Window 保留 dirty、光标、滚动和 Preview 状态。

### 11.4 Extension 原生能力

- EasyView Custom Editor 标签拥有全部要求的原生右键项。
- 四方向拆分后每个 WebviewPanel 可独立显示。
- 一个 Panel 保存后其他 Panel 内容同步。
- Move into New Window 后编辑、保存、关闭正常。
- 不出现 EasyView 重复菜单项。

### 11.5 交付验证

- `npm run typecheck`
- `npm run lint`
- `npm run check:architecture`
- 共享核心单元测试
- Desktop 标签、目录树、多 Group、多窗口 E2E
- VS Code Extension Host E2E
- VSIX 构建、安装、重新加载窗口
- macOS Desktop 实际安装包回归
- Windows Desktop CI 及真实产物验证

## 12. 明确边界

- 首期目录树只支持单选，不引入多选批量文件操作。
- 不实现 Cut、Paste、拖拽移动、文件嵌套、搜索过滤、Git 装饰和自定义排序。
- `Copy` 的文件复制语义未确认前不得用 Copy Path 替代。
- Extension 不访问 VS Code 私有 Workbench 服务。
- Desktop Split 与多窗口必须完成底层模型整改，不允许通过复制 DOM、Iframe 或第二套临时状态实现。
- 不在本功能中重做 Markdown 文档标题目录。
- 不覆盖当前工作区内与本方案无关的未提交改动。
