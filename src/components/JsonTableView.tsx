import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "../useT";

interface JsonTableViewProps {
  value: unknown;
  sourceName: string;
}

interface TableSection {
  key: string;
  path: string;
  columns: string[];
  rows: { path: string; values: Record<string, unknown> }[];
}

export function JsonTableView({ value, sourceName }: JsonTableViewProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{ path: string; value: unknown } | null>(null);
  const sections = useMemo(() => buildSections(value), [value]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sections;
    return sections
      .map((section) => ({
        ...section,
        rows: section.rows.filter((row) =>
          `${row.path} ${JSON.stringify(row.values)}`.toLowerCase().includes(needle)
        )
      }))
      .filter((section) => section.rows.length > 0);
  }, [query, sections]);

  const rowCount = filtered.reduce((sum, section) => sum + section.rows.length, 0);

  return (
    <div className="json-table-view">
      <div className="json-table-toolbar">
        <span className="tt-label">TABLE</span>
        <span className="tt-count">
          {filtered.length} {t("json.sections")} · {rowCount} {t("json.rows")}
        </span>
        <span className="status-spacer" />
        <label className="search-field compact-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("json.tableFilter")}
          />
        </label>
      </div>
      <div className="json-table-scroll">
        {filtered.length === 0 ? (
          <div className="stream-no-events">{t("json.tableNoRows")}</div>
        ) : (
          filtered.map((section) => (
            <section className="table-section" key={section.path}>
              <div className="table-section-head">
                <strong>{section.key}</strong>
                <code>{section.path}</code>
                <span>
                  {section.rows.length} {t("json.rows")}
                </span>
              </div>
              <table className="json-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {section.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, index) => (
                    <tr key={row.path}>
                      <td className="row-index">{index + 1}</td>
                      {section.columns.map((column) => (
                        <td
                          key={column}
                          className={selected?.path === `${row.path}.${column}` ? "selected" : ""}
                          onClick={() =>
                            setSelected({
                              path: `${row.path}.${column}`,
                              value: row.values[column]
                            })
                          }
                        >
                          <CellValue value={row.values[column]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))
        )}
      </div>
      <div className="json-table-foot">
        {selected ? (
          <>
            <code>{selected.path}</code>
            <span>{preview(selected.value)}</span>
          </>
        ) : (
          <span>{sourceName}</span>
        )}
      </div>
    </div>
  );
}

function CellValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return <span className="cell-value array">[{value.length}]</span>;
  }
  if (value !== null && typeof value === "object") {
    return <span className="cell-value object">{"{…}"}</span>;
  }
  if (value === null) return <span className="cell-value null">null</span>;
  if (typeof value === "string") {
    return (
      <span className="cell-value string" title={value}>
        {value}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="cell-value number">{value}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="cell-value boolean">{String(value)}</span>;
  }
  return <span className="cell-value">—</span>;
}

function buildSections(value: unknown): TableSection[] {
  if (Array.isArray(value)) {
    const rows = value.map((item, index) => ({
      path: `$[${index}]`,
      values: rowValues(item)
    }));
    const columns = mergeColumns(rows.map((row) => row.values));
    return [{ key: "root", path: "$", columns, rows }];
  }
  if (isObject(value)) {
    const arraySections: TableSection[] = [];
    const scalarRows: TableSection["rows"] = [];
    for (const [key, item] of Object.entries(value)) {
      if (Array.isArray(item) && item.some(isObject)) {
        const rows = item.map((entry, index) => ({
          path: `$.${key}[${index}]`,
          values: rowValues(entry)
        }));
        arraySections.push({
          key,
          path: `$.${key}`,
          columns: mergeColumns(rows.map((row) => row.values)),
          rows
        });
      } else {
        scalarRows.push({
          path: /^[A-Za-z_$][\w$]*$/.test(key) ? `$.${key}` : `$[${JSON.stringify(key)}]`,
          values: { value: item }
        });
      }
    }
    if (scalarRows.length) {
      arraySections.push({
        key: "meta",
        path: "$",
        columns: ["value"],
        rows: scalarRows
      });
    }
    return arraySections;
  }
  return [{ key: "root", path: "$", columns: ["value"], rows: [{ path: "$", values: { value } }] }];
}

function rowValues(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  return { value };
}

function mergeColumns(rows: Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preview(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 97)}…` : text;
}
