interface CodegenContext {
  interfaces: Map<string, string>;
  usedNames: Set<string>;
}

export function rootNameForFile(fileName: string): string {
  const stem = fileName.replace(/\.json$/i, "");
  const parts = stem
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const name = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  if (!name || /^[0-9]/.test(name)) return "Root";
  return name;
}

export function generateTypescript(value: unknown, rootName: string, sourceName: string): string {
  const ctx: CodegenContext = { interfaces: new Map(), usedNames: new Set() };
  let rootType: string;

  if (isPlainObject(value)) {
    rootType = buildInterface(rootName, value, ctx);
  } else if (Array.isArray(value)) {
    rootType = typeForValue(value, rootName, ctx);
  } else {
    rootType = primitiveType(value);
  }

  const blocks = [...ctx.interfaces.values()];
  const lines = [`// Generated from ${sourceName}`, ""];
  for (const block of blocks) {
    lines.push(block, "");
  }
  if (rootType !== rootName) {
    lines.push(`export type ${rootName} = ${rootType};`, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

function buildInterface(name: string, value: Record<string, unknown>, ctx: CodegenContext): string {
  const assigned = uniqueName(name, ctx);
  if (ctx.interfaces.has(assigned)) return assigned;
  const placeholder = `export interface ${assigned} {\n}`;
  ctx.interfaces.set(assigned, placeholder);

  const rows: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    const propertyName = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    const type = typeForValue(item, assigned + pascalCase(key), ctx);
    rows.push(`  ${propertyName}: ${type};`);
  }
  ctx.interfaces.set(assigned, `export interface ${assigned} {\n${rows.join("\n")}\n}`);
  return assigned;
}

function buildMergedInterface(
  name: string,
  values: Record<string, unknown>[],
  ctx: CodegenContext
): string {
  const assigned = uniqueName(name, ctx);
  if (ctx.interfaces.has(assigned)) return assigned;

  const keys: string[] = [];
  for (const value of values) {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }

  const rows: string[] = [];
  for (const key of keys) {
    const present = values.filter((value) => Object.prototype.hasOwnProperty.call(value, key));
    const types = uniqueTypes(
      present.map((value) => typeForValue(value[key], assigned + pascalCase(key), ctx))
    );
    const optional = present.length !== values.length ? "?" : "";
    const propertyName = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    rows.push(`  ${propertyName}${optional}: ${types.join(" | ")};`);
  }

  ctx.interfaces.set(assigned, `export interface ${assigned} {\n${rows.join("\n")}\n}`);
  return assigned;
}

function typeForValue(value: unknown, nameHint: string, ctx: CodegenContext): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (!value.length) return "unknown[]";
    const objects = value.filter(isPlainObject);
    if (objects.length === value.length) {
      return `${buildMergedInterface(nameHint + "Item", objects, ctx)}[]`;
    }
    const types = uniqueTypes(value.map((item) => typeForValue(item, nameHint + "Item", ctx)));
    if (types.length === 1 && !types[0].includes(" | ")) return `${types[0]}[]`;
    return `Array<${types.join(" | ")}>`;
  }
  if (isPlainObject(value)) return buildInterface(nameHint || "Nested", value, ctx);
  return primitiveType(value);
}

function primitiveType(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "unknown";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pascalCase(value: string): string {
  const parts = value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function uniqueName(name: string, ctx: CodegenContext): string {
  const base = name && /^[A-Za-z_$][\w$]*$/.test(name) ? name : "Nested";
  if (!ctx.usedNames.has(base)) {
    ctx.usedNames.add(base);
    return base;
  }
  let suffix = 2;
  while (ctx.usedNames.has(`${base}${suffix}`)) suffix += 1;
  const next = `${base}${suffix}`;
  ctx.usedNames.add(next);
  return next;
}

function uniqueTypes(types: string[]): string[] {
  return [...new Set(types)];
}
