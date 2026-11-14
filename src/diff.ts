export type ChangeKind = "modified" | "added" | "removed";
export type RowKind = "equal" | "replace" | "add" | "remove";

export interface StructuralChange {
  id: string;
  path: string;
  kind: ChangeKind;
  oldValue?: string;
  newValue?: string;
}

export interface DiffRow {
  aNo: number | null;
  bNo: number | null;
  aText: string | null;
  bText: string | null;
  kind: RowKind;
}

interface Leaf {
  value: unknown;
}

interface LineOperation {
  kind: "equal" | "remove" | "insert";
  aNo: number | null;
  bNo: number | null;
  text: string;
}

export function normalizeForDisplay(value: unknown, ignoreKeyOrder: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForDisplay(item, ignoreKeyOrder));
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    const keys = Object.keys(value);
    if (ignoreKeyOrder) keys.sort();
    for (const key of keys) {
      output[key] = normalizeForDisplay(value[key], ignoreKeyOrder);
    }
    return output;
  }
  return value;
}

export function prettyForCompare(value: unknown, ignoreKeyOrder: boolean): string {
  return `${JSON.stringify(normalizeForDisplay(value, ignoreKeyOrder), null, 2)}\n`;
}

export function structuralChanges(
  a: unknown,
  b: unknown,
  ignoreKeyOrder: boolean
): StructuralChange[] {
  const aLeaves = new Map<string, Leaf>();
  const bLeaves = new Map<string, Leaf>();
  flatten(a, "$", aLeaves);
  flatten(b, "$", bLeaves);

  const changes: StructuralChange[] = [];
  const paths = [...new Set([...aLeaves.keys(), ...bLeaves.keys()])].sort();
  for (const path of paths) {
    const left = aLeaves.get(path);
    const right = bLeaves.get(path);
    if (left && !right) {
      changes.push({
        id: `removed-${changes.length}`,
        path,
        kind: "removed",
        oldValue: valueLabel(left.value)
      });
    } else if (!left && right) {
      changes.push({
        id: `added-${changes.length}`,
        path,
        kind: "added",
        newValue: valueLabel(right.value)
      });
    } else if (left && right && valueLabel(left.value) !== valueLabel(right.value)) {
      changes.push({
        id: `modified-${changes.length}`,
        path,
        kind: "modified",
        oldValue: valueLabel(left.value),
        newValue: valueLabel(right.value)
      });
    }
  }

  if (!ignoreKeyOrder) {
    const aOrders = new Map<string, string[]>();
    const bOrders = new Map<string, string[]>();
    collectKeyOrders(a, "$", aOrders);
    collectKeyOrders(b, "$", bOrders);
    for (const [path, aKeys] of aOrders) {
      const bKeys = bOrders.get(path);
      if (!bKeys || aKeys.join("\u0000") === bKeys.join("\u0000")) continue;
      changes.push({
        id: `order-${changes.length}`,
        path,
        kind: "modified",
        oldValue: aKeys.join(", "),
        newValue: bKeys.join(", ")
      });
    }
  }

  return changes;
}

export function textChanges(rows: DiffRow[]): StructuralChange[] {
  const changes: StructuralChange[] = [];
  for (const row of rows) {
    if (row.kind === "equal") continue;
    changes.push({
      id: `line-${changes.length}`,
      path:
        row.aNo != null && row.bNo != null
          ? `L${row.aNo} → L${row.bNo}`
          : row.aNo != null
            ? `L${row.aNo}`
            : `L${row.bNo}`,
      kind:
        row.kind === "replace" ? "modified" : row.kind === "add" ? "added" : "removed",
      oldValue: row.aText ?? undefined,
      newValue: row.bText ?? undefined
    });
  }
  return changes;
}

export function lineDiff(aText: string, bText: string): DiffRow[] {
  const aLines = splitLines(aText);
  const bLines = splitLines(bText);
  const operations =
    aLines.length * bLines.length > 4_000_000
      ? fallbackOperations(aLines, bLines)
      : lcsOperations(aLines, bLines);

  const rows: DiffRow[] = [];
  let index = 0;
  while (index < operations.length) {
    const operation = operations[index];
    if (operation.kind === "equal") {
      rows.push({
        aNo: operation.aNo,
        bNo: operation.bNo,
        aText: operation.text,
        bText: operation.text,
        kind: "equal"
      });
      index += 1;
      continue;
    }

    const removes: LineOperation[] = [];
    const inserts: LineOperation[] = [];
    while (index < operations.length && operations[index].kind !== "equal") {
      const current = operations[index];
      if (current.kind === "remove") removes.push(current);
      else inserts.push(current);
      index += 1;
    }
    const count = Math.max(removes.length, inserts.length);
    for (let part = 0; part < count; part += 1) {
      const removed = removes[part];
      const inserted = inserts[part];
      rows.push({
        aNo: removed?.aNo ?? null,
        bNo: inserted?.bNo ?? null,
        aText: removed?.text ?? null,
        bText: inserted?.text ?? null,
        kind:
          removed && inserted
            ? "replace"
            : removed
              ? "remove"
              : "add"
      });
    }
  }
  return rows;
}

export function valueLabel(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const text = JSON.stringify(value);
  return text.length > 72 ? `${text.slice(0, 69)}…` : text;
}

function flatten(value: unknown, path: string, output: Map<string, Leaf>): void {
  if (Array.isArray(value)) {
    if (!value.length) {
      output.set(path, { value });
      return;
    }
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, output));
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) {
      output.set(path, { value });
      return;
    }
    for (const key of keys) {
      flatten(value[key], pathForChild(path, key), output);
    }
    return;
  }
  output.set(path, { value });
}

function collectKeyOrders(
  value: unknown,
  path: string,
  output: Map<string, string[]>
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeyOrders(item, `${path}[${index}]`, output));
    return;
  }
  if (!isPlainObject(value)) return;
  const keys = Object.keys(value);
  if (keys.length > 1) output.set(path, keys);
  for (const key of keys) {
    collectKeyOrders(value[key], pathForChild(path, key), output);
  }
}

function pathForChild(base: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `${base}.${key}`
    : `${base}[${JSON.stringify(key)}]`;
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsOperations(a: string[], b: string[]): LineOperation[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1)
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const operations: LineOperation[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      operations.push({ kind: "equal", aNo: i + 1, bNo: j + 1, text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      operations.push({ kind: "remove", aNo: i + 1, bNo: null, text: a[i] });
      i += 1;
    } else {
      operations.push({ kind: "insert", aNo: null, bNo: j + 1, text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    operations.push({ kind: "remove", aNo: i + 1, bNo: null, text: a[i] });
    i += 1;
  }
  while (j < m) {
    operations.push({ kind: "insert", aNo: null, bNo: j + 1, text: b[j] });
    j += 1;
  }
  return operations;
}

function fallbackOperations(a: string[], b: string[]): LineOperation[] {
  const operations: LineOperation[] = [];
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left !== undefined && right !== undefined) {
      if (left === right) {
        operations.push({ kind: "equal", aNo: index + 1, bNo: index + 1, text: left });
      } else {
        operations.push({ kind: "remove", aNo: index + 1, bNo: null, text: left });
        operations.push({ kind: "insert", aNo: null, bNo: index + 1, text: right });
      }
    } else if (left !== undefined) {
      operations.push({ kind: "remove", aNo: index + 1, bNo: null, text: left });
    } else if (right !== undefined) {
      operations.push({ kind: "insert", aNo: null, bNo: index + 1, text: right });
    }
  }
  return operations;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
