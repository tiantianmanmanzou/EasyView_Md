export type OpSource = 'manual' | 'ai';

export type Rev = number;

export interface Locator {
  /** OPC part name, e.g. `xl/worksheets/sheet1.xml`. */
  part?: string;
  /** Format-specific path (XPath-like or key). */
  path?: string;
  /** Format-specific key, e.g. `Sheet1!B2`. */
  key?: string;
}

export interface DocumentOp {
  id?: string;
  source: OpSource;
  target: Locator;
  op: string;
  args?: unknown;
}

export interface ChangeEvent {
  rev: Rev;
  parts: string[];
  source: OpSource;
}
