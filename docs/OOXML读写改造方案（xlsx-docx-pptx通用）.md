# EasyView OOXML 读写改造方案 v2（xlsx / docx / pptx 通用）

> 状态：**执行中**。工作分支：`feat/ooxml-read-write`。

## 1. 目标

- **全部改造，三种格式一次做完**：xlsx、docx、pptx 的读、写、预览桥接、AI 读取与操作全部迁到新内核；不保留旧写回路径。
- **直接改现有 docx 产品行为**：废弃 AI 仅「批注 / 建议修订」模式；docx AI 经统一 `apply` **直接改正文**。
- **一套内核，三种格式**：`packages/ooxml-core` + `ooxml-xlsx` / `ooxml-docx` / `ooxml-pptx`。
- **真正的局部写回**：干净 zip 部件原样保留；XML 只改目标字节区间。
- **彻底去掉 ExcelJS**（生产路径）。
- **统一入口**：页面编辑、保存、AI 都走 `DocumentService` 的 `query` / `apply` / `save`。
- 测试用例目录：`sample/`（与文档示例 `samples/` 分开）。外部冲突：提示用户选「覆盖 / 重新加载」。

## 2. 执行顺序（同一交付内依赖序）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 12.0 | 包骨架、接口草案、sample/、本文件入库 | **完成** |
| P0 | OPC + engine.apply + ops/rev/IO | **完成** |
| P1 | ooxml-xlsx 去 ExcelJS | **进行中** — 适配器 + AI + export + 预览样式保存已切 ooxml；预览 decode/load 仍用 ExcelJS |
| P2 | ooxml-docx 并轨 + AI 改正文 | **进行中** — AI 确认后写正文；`ooxml-docx` 适配器已接入；精准 run 级 XML 写回待续 |
| P3 | ooxml-pptx | 待开始 |
| P4–P6 | 宿主同步、测试加固、验收 | 待开始 |

### P1 细项

| # | 动作 | 状态 |
|---|---|---|
| 2.1 | 读 sheet / sharedStrings；视图可读 | **完成**（`XlsxWorkbook`） |
| 2.2 | 单元格/区域/公式精准写回；未改部件字节不变 | **完成**（sheetData 重写 + fidelity 单测） |
| 2.3 | `fullCalcOnLoad` | **完成**（flush 时写入） |
| 2.4 | 插删行列级联（公式/图表锚点等全量） | 部分：单元格网格平移已支持；锚点/名称级联待补 |
| 2.5 | 工作表增删改名 | 待开始 |
| 2.6 | 替换 AI `xlsx-edit.ts`；去掉整簿 `writeBuffer` | **完成** |
| 2.7 | 替换 `LazyWorkbook` / SpreadsheetViewer 保存路径 | **完成**（value-only + 样式/合并/冻结/筛选/列宽行高均走 XML；decode/load 仍 ExcelJS） |
| 2.8 | new-file / export / git snapshot；移除生产 `exceljs` | 部分：new-file + snapshot + export 已切；预览 decode 与测试夹具仍依赖 exceljs |
| 2.9 | `PreviewController.open` 同路径强制刷新 | **完成**（此前 CI 修复） |

## 3. 公开接口草案（冻结）

```ts
// @easyview/ooxml-core
type Rev = number;
type OpSource = 'manual' | 'ai';

interface Locator { part?: string; path?: string; key?: string }

interface DocumentService {
  readonly rev: Rev;
  query: {
    summary(): Promise<unknown>;
    read(locator: Locator): Promise<unknown>;
  };
  apply(ops: Array<{ id?: string; source: OpSource; target: Locator; op: string; args?: unknown }>): Promise<{ rev: Rev }>;
  save(opts?: { overwriteExternal?: boolean }): Promise<{ fingerprint: string }>;
  subscribe(listener: (event: { rev: Rev; parts: string[] }) => void): () => void;
}

// Precise update engine (format-agnostic)
engine.apply(updates: Array<{ target: Locator; change: Change }>): void
```

包布局：

```
packages/ooxml-core/
packages/ooxml-xlsx/
packages/ooxml-docx/
packages/ooxml-pptx/
sample/{xlsx,docx,pptx,cases,harness}/
```
