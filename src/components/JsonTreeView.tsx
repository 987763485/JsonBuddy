import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../useT";

interface JsonTreeViewProps {
  value: unknown;
  sourceName: string;
}

interface TreeNode {
  key: string;
  path: string;
  value: unknown;
  kind: "object" | "array" | "string" | "number" | "boolean" | "null";
}

export function JsonTreeView({ value, sourceName }: JsonTreeViewProps) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["$"]));
  const root = useMemo(() => buildRoot(value), [value]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (!root) {
    return (
      <div className="view-placeholder">
        <h2>{t("json.codeEmpty")}</h2>
      </div>
    );
  }

  return (
    <div className="json-tree">
      <div className="json-tree-head">
        <span>{t("json.view.tree")}</span>
        <code>{sourceName}</code>
        <span className="status-spacer" />
        <span>{t("json.treePaths")}</span>
      </div>
      <div className="json-tree-scroll">
        <TreeRow
          node={root}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
        />
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
}) {
  const expandable = node.kind === "object" || node.kind === "array";
  const isOpen = expanded.has(node.path);
  const entries = expandable ? childEntries(node) : [];

  return (
    <div className="json-tree-node">
      <div
        className="json-tree-row"
        style={{ paddingLeft: 10 + depth * 16 }}
        onClick={() => expandable && onToggle(node.path)}
      >
        <span className="tree-chevron">
          {expandable ? (
            isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />
          ) : null}
        </span>
        <span className="tree-key">{node.key}</span>
        <span className={`tree-type ${node.kind}`}>{typeLabel(node)}</span>
        {!expandable ? (
          <span className="tree-value">{valuePreview(node.value)}</span>
        ) : (
          <span className="tree-count">
            {entries.length} {node.kind === "array" ? "items" : "keys"}
          </span>
        )}
      </div>
      {expandable && isOpen
        ? entries.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
            />
          ))
        : null}
    </div>
  );
}

function buildRoot(value: unknown): TreeNode | null {
  if (value === undefined) return null;
  return {
    key: "$",
    path: "$",
    value,
    kind: kindOf(value)
  };
}

function childEntries(node: TreeNode): TreeNode[] {
  if (Array.isArray(node.value)) {
    return node.value.map((item, index) => ({
      key: String(index),
      path: `${node.path}[${index}]`,
      value: item,
      kind: kindOf(item)
    }));
  }
  if (isObject(node.value)) {
    return Object.entries(node.value).map(([key, item]) => ({
      key,
      path: /^[A-Za-z_$][\w$]*$/.test(key)
        ? `${node.path}.${key}`
        : `${node.path}[${JSON.stringify(key)}]`,
      value: item,
      kind: kindOf(item)
    }));
  }
  return [];
}

function kindOf(value: unknown): TreeNode["kind"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isObject(value)) return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeLabel(node: TreeNode): string {
  if (node.kind === "array" && Array.isArray(node.value)) {
    return `array[${node.value.length}]`;
  }
  return node.kind;
}

function valuePreview(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 60 ? `"${value.slice(0, 57)}…"` : JSON.stringify(value);
  }
  if (value === null) return "null";
  return String(value);
}
