use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCode {
    pub code: String,
    pub file: String,
    pub root_name: String,
    pub types: usize,
    pub records: u64,
    pub root_label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CgKind {
    String,
    Number,
    Integer,
    Boolean,
    Unknown,
    Null,
    Array,
    Object,
    Union,
}

#[derive(Clone, Debug)]
struct CgType {
    kind: CgKind,
    item: Option<Box<CgType>>,
    object: Option<usize>,
    object_clone: Option<Box<CgObject>>,
    types: Vec<CgType>,
    nullable: bool,
}

impl CgType {
    fn simple(kind: CgKind) -> Self {
        Self {
            kind,
            item: None,
            object: None,
            object_clone: None,
            types: Vec::new(),
            nullable: false,
        }
    }

    fn unknown_nullable() -> Self {
        Self {
            nullable: true,
            ..Self::simple(CgKind::Unknown)
        }
    }

    fn object(index: usize) -> Self {
        Self {
            object: Some(index),
            ..Self::simple(CgKind::Object)
        }
    }

    fn object_name(&self, objects: &[CgObject]) -> Option<String> {
        if let Some(index) = self.object {
            objects.get(index).map(|object| object.name.clone())
        } else {
            self.object_clone.as_ref().map(|object| object.name.clone())
        }
    }

    fn array(item: CgType) -> Self {
        Self {
            item: Some(Box::new(item)),
            ..Self::simple(CgKind::Array)
        }
    }

    fn union(types: Vec<CgType>, nullable: bool) -> Self {
        Self {
            types,
            nullable,
            ..Self::simple(CgKind::Union)
        }
    }
}

#[derive(Clone, Debug)]
struct CgField {
    key: String,
    ty: CgType,
    required: bool,
}

#[derive(Clone, Debug)]
struct CgObject {
    name: String,
    fields: Vec<CgField>,
}

fn clone_object_detached(object: &CgObject, objects: &[CgObject]) -> CgObject {
    CgObject {
        name: object.name.clone(),
        fields: object
            .fields
            .iter()
            .map(|field| CgField {
                key: field.key.clone(),
                required: field.required,
                ty: clone_type_detached(&field.ty, objects),
            })
            .collect(),
    }
}

fn clone_type_detached(ty: &CgType, objects: &[CgObject]) -> CgType {
    CgType {
        kind: ty.kind,
        item: ty
            .item
            .as_ref()
            .map(|item| Box::new(clone_type_detached(item, objects))),
        object: None,
        object_clone: ty
            .object
            .and_then(|index| objects.get(index))
            .map(|object| Box::new(clone_object_detached(object, objects)))
            .or_else(|| ty.object_clone.clone()),
        types: ty
            .types
            .iter()
            .map(|item| clone_type_detached(item, objects))
            .collect(),
        nullable: ty.nullable,
    }
}

#[derive(Default)]
struct CgContext {
    objects: Vec<CgObject>,
    names: HashSet<String>,
}

fn words(value: &str) -> Vec<String> {
    value
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn pascal(value: &str) -> String {
    let name = words(value)
        .into_iter()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<String>();
    if name.is_empty() {
        "Nested".to_string()
    } else {
        name
    }
}

fn camel(value: &str) -> String {
    let name = pascal(value);
    let mut chars = name.chars();
    match chars.next() {
        Some(first) => first.to_ascii_lowercase().to_string() + chars.as_str(),
        None => name,
    }
}

fn snake(value: &str) -> String {
    words(value)
        .into_iter()
        .enumerate()
        .map(|(index, word)| {
            if index == 0 {
                word.to_ascii_lowercase()
            } else {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => {
                        first.to_ascii_uppercase().to_string()
                            + chars.as_str().to_ascii_lowercase().as_str()
                    }
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join("_")
}

fn kebab(value: &str) -> String {
    words(value)
        .into_iter()
        .map(|word| word.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("-")
}

fn singular(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let irregular = match lower.as_str() {
        "movies" => Some("movie"),
        "cookies" => Some("cookie"),
        "zombies" => Some("zombie"),
        "ties" => Some("tie"),
        "pies" => Some("pie"),
        "lies" => Some("lie"),
        "series" => Some("series"),
        "species" => Some("species"),
        _ => None,
    };
    if let Some(base) = irregular {
        let mut chars = base.chars();
        return match chars.next() {
            Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
            None => value.to_string(),
        };
    }
    if lower.ends_with("ies") && value.len() > 3 {
        return format!("{}y", &value[..value.len() - 3]);
    }
    if lower.ends_with("ss")
        || lower.ends_with('x')
        || lower.ends_with("ch")
        || lower.ends_with("sh")
    {
        return value.to_string();
    }
    if lower.ends_with('s') && value.len() > 1 {
        return value[..value.len() - 1].to_string();
    }
    value.to_string()
}

fn unique(ctx: &mut CgContext, base: &str) -> String {
    let base = if base.is_empty() { "Nested" } else { base };
    let mut candidate = base.to_string();
    let mut index = 2;
    while ctx.names.contains(&candidate) {
        candidate = format!("{base}{index}");
        index += 1;
    }
    ctx.names.insert(candidate.clone());
    candidate
}

fn merge_schemas_in_object(ctx: &mut CgContext, target: &mut CgObject, source: &CgObject) {
    let source_keys: HashSet<String> = source
        .fields
        .iter()
        .map(|field| field.key.clone())
        .collect();
    for field in &mut target.fields {
        if !source_keys.contains(&field.key) {
            field.required = false;
        }
    }
    let first = target.fields.is_empty();
    for source_field in &source.fields {
        let position = target
            .fields
            .iter()
            .position(|field| field.key == source_field.key);
        if let Some(position) = position {
            let required = target.fields[position].required && source_field.required;
            let current = target.fields[position].ty.clone();
            let merged = merge_types(&current, &source_field.ty, ctx);
            target.fields[position].required = required;
            target.fields[position].ty = merged;
        } else {
            target.fields.push(CgField {
                key: source_field.key.clone(),
                required: first && source_field.required,
                ty: clone_type_detached(&source_field.ty, &ctx.objects),
            });
        }
    }
}

fn merge_schemas(ctx: &mut CgContext, target: usize, source: &CgObject) {
    let name = ctx.objects[target].name.clone();
    let mut object = std::mem::replace(
        &mut ctx.objects[target],
        CgObject {
            name: String::new(),
            fields: Vec::new(),
        },
    );
    merge_schemas_in_object(ctx, &mut object, source);
    object.name = name;
    ctx.objects[target] = object;
}

fn merge_union(left: &CgType, right: &CgType, ctx: &mut CgContext) -> CgType {
    let mut types = left.types.clone();
    if right.kind == CgKind::Union {
        types.extend(right.types.clone());
    } else {
        types.push(right.clone());
    }
    let mut merged: Vec<CgType> = Vec::new();
    for item in types {
        let position = merged.iter().position(|candidate| {
            candidate.kind == item.kind
                && (candidate.kind != CgKind::Object
                    || candidate.object_name(&ctx.objects) == item.object_name(&ctx.objects))
        });
        if let Some(position) = position {
            merged[position].nullable = merged[position].nullable || item.nullable;
            if merged[position].kind == CgKind::Array {
                let left_item = merged[position].item.as_ref().map(|item| (**item).clone());
                let right_item = item.item.as_ref().map(|item| (**item).clone());
                if let (Some(left_item), Some(right_item)) = (left_item, right_item) {
                    merged[position].item =
                        Some(Box::new(merge_types(&left_item, &right_item, ctx)));
                }
            }
        } else {
            merged.push(clone_type_detached(&item, &ctx.objects));
        }
    }
    CgType::union(merged, left.nullable || right.nullable)
}

fn merge_types(left: &CgType, right: &CgType, ctx: &mut CgContext) -> CgType {
    if left.kind == CgKind::Null {
        let mut clone = clone_type_detached(right, &ctx.objects);
        clone.nullable = true;
        return clone;
    }
    if right.kind == CgKind::Null {
        let mut clone = clone_type_detached(left, &ctx.objects);
        clone.nullable = true;
        return clone;
    }
    if left.kind == CgKind::Unknown {
        let mut clone = clone_type_detached(right, &ctx.objects);
        clone.nullable = clone.nullable || left.nullable;
        return clone;
    }
    if right.kind == CgKind::Unknown {
        let mut clone = clone_type_detached(left, &ctx.objects);
        clone.nullable = clone.nullable || right.nullable;
        return clone;
    }
    if left.kind == CgKind::Union {
        return merge_union(left, right, ctx);
    }
    if right.kind == CgKind::Union {
        return merge_union(right, left, ctx);
    }
    if matches!(left.kind, CgKind::Number | CgKind::Integer)
        && matches!(right.kind, CgKind::Number | CgKind::Integer)
    {
        let kind = if left.kind == CgKind::Integer && right.kind == CgKind::Integer {
            CgKind::Integer
        } else {
            CgKind::Number
        };
        return CgType {
            nullable: left.nullable || right.nullable,
            ..CgType::simple(kind)
        };
    }
    if left.kind == right.kind {
        match left.kind {
            CgKind::Object => {
                let source = if let Some(right_index) = right.object {
                    ctx.objects.get(right_index).cloned()
                } else {
                    right.object_clone.as_ref().map(|object| (**object).clone())
                };
                if let Some(source) = source {
                    if let Some(left_index) = left.object {
                        merge_schemas(ctx, left_index, &source);
                        let mut result = left.clone();
                        result.nullable = left.nullable || right.nullable;
                        return result;
                    }
                    if let Some(left_clone) = &left.object_clone {
                        let mut object = (**left_clone).clone();
                        merge_schemas_in_object(ctx, &mut object, &source);
                        let mut result = left.clone();
                        result.object_clone = Some(Box::new(object));
                        result.nullable = left.nullable || right.nullable;
                        return result;
                    }
                }
            }
            CgKind::Array => {
                if let (Some(left_item), Some(right_item)) = (&left.item, &right.item) {
                    let merged = merge_types(left_item, right_item, ctx);
                    let mut result = left.clone();
                    result.item = Some(Box::new(merged));
                    result.nullable = left.nullable || right.nullable;
                    return result;
                }
            }
            _ => {
                let mut result = left.clone();
                result.nullable = left.nullable || right.nullable;
                return result;
            }
        }
    }
    CgType::union(vec![left.clone(), right.clone()], false)
}

fn infer_object_schema(value: &Map<String, Value>, ctx: &mut CgContext) -> CgObject {
    let mut object = CgObject {
        name: "Nested".to_string(),
        fields: Vec::new(),
    };
    for (key, item) in value {
        let ty = infer(item, key, ctx);
        object.fields.push(CgField {
            key: key.clone(),
            ty,
            required: true,
        });
    }
    object
}

fn infer(value: &Value, hint: &str, ctx: &mut CgContext) -> CgType {
    match value {
        Value::Null => CgType::unknown_nullable(),
        Value::Array(items) => {
            if items.is_empty() {
                return CgType::array(CgType::simple(CgKind::Unknown));
            }
            if items.iter().all(Value::is_object) {
                let name = unique(ctx, &singular(&pascal(hint)));
                let index = ctx.objects.len();
                ctx.objects.push(CgObject {
                    name,
                    fields: Vec::new(),
                });
                for item in items {
                    if let Value::Object(object) = item {
                        let schema = infer_object_schema(object, ctx);
                        merge_schemas(ctx, index, &schema);
                    }
                }
                return CgType::array(CgType::object(index));
            }
            let mut item = infer(&items[0], hint, ctx);
            for entry in &items[1..] {
                let next = infer(entry, hint, ctx);
                item = merge_types(&item, &next, ctx);
            }
            CgType::array(item)
        }
        Value::Object(object) => {
            let name = unique(ctx, &pascal(hint));
            let index = ctx.objects.len();
            ctx.objects.push(CgObject {
                name,
                fields: Vec::new(),
            });
            let schema = infer_object_schema(object, ctx);
            merge_schemas(ctx, index, &schema);
            CgType::object(index)
        }
        Value::String(_) => CgType::simple(CgKind::String),
        Value::Number(number) => {
            let integer = number
                .as_f64()
                .map(|value| value.fract() == 0.0)
                .unwrap_or(false);
            CgType::simple(if integer {
                CgKind::Integer
            } else {
                CgKind::Number
            })
        }
        Value::Bool(_) => CgType::simple(CgKind::Boolean),
    }
}

fn collect_dependencies(ty: &CgType, objects: &[CgObject], output: &mut Vec<String>) {
    if ty.kind == CgKind::Object {
        if let Some(name) = ty.object_name(objects) {
            output.push(name);
        }
    } else if ty.kind == CgKind::Array {
        if let Some(item) = &ty.item {
            collect_dependencies(item, objects, output);
        }
    } else if ty.kind == CgKind::Union {
        for item in &ty.types {
            collect_dependencies(item, objects, output);
        }
    }
}

fn ordered_objects(ctx: &CgContext) -> Vec<usize> {
    let by_name: std::collections::HashMap<&str, usize> = ctx
        .objects
        .iter()
        .enumerate()
        .map(|(index, object)| (object.name.as_str(), index))
        .collect();
    let mut visited = vec![false; ctx.objects.len()];
    let mut output = Vec::new();
    for index in 0..ctx.objects.len() {
        visit_object(ctx, &by_name, index, &mut visited, &mut output);
    }
    output
}

fn visit_object(
    ctx: &CgContext,
    by_name: &std::collections::HashMap<&str, usize>,
    index: usize,
    visited: &mut [bool],
    output: &mut Vec<usize>,
) {
    if index >= ctx.objects.len() || visited[index] {
        return;
    }
    visited[index] = true;
    let mut dependencies = Vec::new();
    for field in &ctx.objects[index].fields {
        collect_dependencies(&field.ty, &ctx.objects, &mut dependencies);
    }
    for dependency in dependencies {
        if let Some(next) = by_name.get(dependency.as_str()) {
            visit_object(ctx, by_name, *next, visited, output);
        }
    }
    output.push(index);
}

#[derive(Clone, Copy)]
enum NameStyle {
    Pascal,
    Camel,
    Snake,
}

const KEYWORDS: [&str; 24] = [
    "class",
    "interface",
    "struct",
    "type",
    "public",
    "private",
    "default",
    "new",
    "return",
    "import",
    "package",
    "func",
    "var",
    "let",
    "const",
    "null",
    "true",
    "false",
    "in",
    "is",
    "as",
    "object",
    "string",
    "number",
];

fn identifier(value: &str, style: NameStyle) -> String {
    let mut name = match style {
        NameStyle::Pascal => pascal(value),
        NameStyle::Camel => camel(value),
        NameStyle::Snake => snake(value),
    };
    if name.is_empty() {
        name = "field".to_string();
    }
    if name.as_bytes().first().is_some_and(u8::is_ascii_digit) {
        name = format!("_{name}");
    }
    if KEYWORDS.contains(&name.to_ascii_lowercase().as_str()) {
        name = format!("{name}_");
    }
    name
}

fn object_fields(object: &CgObject, style: NameStyle) -> Vec<(CgField, String)> {
    let mut used = HashSet::new();
    object
        .fields
        .iter()
        .map(|field| {
            let base = identifier(&field.key, style);
            let mut name = base.clone();
            let mut index = 2;
            while used.contains(&name) {
                name = format!("{base}{index}");
                index += 1;
            }
            used.insert(name.clone());
            (field.clone(), name)
        })
        .collect()
}

fn primitive_type(kind: CgKind, lang: &str) -> Option<&'static str> {
    let values = match lang {
        "typescript" | "javascript" => match kind {
            CgKind::String => "string",
            CgKind::Integer | CgKind::Number => "number",
            CgKind::Boolean => "boolean",
            CgKind::Unknown => "unknown",
            CgKind::Null => "null",
            _ => return None,
        },
        "go" => match kind {
            CgKind::String => "string",
            CgKind::Integer => "int64",
            CgKind::Number => "float64",
            CgKind::Boolean => "bool",
            CgKind::Unknown | CgKind::Null => "interface{}",
            _ => return None,
        },
        "rust" => match kind {
            CgKind::String => "String",
            CgKind::Integer => "i64",
            CgKind::Number => "f64",
            CgKind::Boolean => "bool",
            CgKind::Unknown | CgKind::Null => "serde_json::Value",
            _ => return None,
        },
        "python" => match kind {
            CgKind::String => "str",
            CgKind::Integer => "int",
            CgKind::Number => "float",
            CgKind::Boolean => "bool",
            CgKind::Unknown => "Any",
            CgKind::Null => "None",
            _ => return None,
        },
        "java" => match kind {
            CgKind::String => "String",
            CgKind::Integer => "Long",
            CgKind::Number => "Double",
            CgKind::Boolean => "Boolean",
            CgKind::Unknown | CgKind::Null => "Object",
            _ => return None,
        },
        "csharp" => match kind {
            CgKind::String => "string",
            CgKind::Integer => "long",
            CgKind::Number => "double",
            CgKind::Boolean => "bool",
            CgKind::Unknown | CgKind::Null => "object",
            _ => return None,
        },
        "swift" => match kind {
            CgKind::String => "String",
            CgKind::Integer => "Int",
            CgKind::Number => "Double",
            CgKind::Boolean => "Bool",
            CgKind::Unknown | CgKind::Null => "JSONValue",
            _ => return None,
        },
        "kotlin" => match kind {
            CgKind::String => "String",
            CgKind::Integer => "Long",
            CgKind::Number => "Double",
            CgKind::Boolean => "Boolean",
            CgKind::Unknown | CgKind::Null => "Any",
            _ => return None,
        },
        "php" => match kind {
            CgKind::String => "string",
            CgKind::Integer => "int",
            CgKind::Number => "float",
            CgKind::Boolean => "bool",
            CgKind::Unknown | CgKind::Null => "mixed",
            _ => return None,
        },
        _ => match kind {
            CgKind::String => "String",
            CgKind::Integer => "int",
            CgKind::Number => "double",
            CgKind::Boolean => "bool",
            CgKind::Unknown | CgKind::Null => "dynamic",
            _ => return None,
        },
    };
    Some(values)
}

fn nullable_type(base: &str, lang: &str) -> String {
    match lang {
        "typescript" | "javascript" => format!("{base} | null"),
        "go" => {
            if base == "interface{}" {
                base.to_string()
            } else {
                format!("*{base}")
            }
        }
        "rust" => format!("Option<{base}>"),
        "python" => format!("Optional[{base}]"),
        "java" => base.to_string(),
        "csharp" => format!("{base}?"),
        "swift" | "kotlin" | "php" => {
            if base == "mixed" {
                base.to_string()
            } else {
                format!("?{base}")
            }
        }
        "dart" => {
            if base == "dynamic" {
                base.to_string()
            } else {
                format!("{base}?")
            }
        }
        _ => base.to_string(),
    }
}

fn type_base(ty: &CgType, lang: &str, objects: &[CgObject], nullable: bool) -> String {
    if let Some(primitive) = primitive_type(ty.kind, lang) {
        if !ty.nullable && !nullable {
            return primitive.to_string();
        }
        return nullable_type(primitive, lang);
    }
    if ty.kind == CgKind::Object {
        return ty
            .object_name(objects)
            .unwrap_or_else(|| "Nested".to_string());
    }
    if ty.kind == CgKind::Array {
        let inside = ty
            .item
            .as_ref()
            .map(|item| type_base(item, lang, objects, false))
            .unwrap_or_else(|| "unknown".to_string());
        let wrapped = match lang {
            "go" => format!("[]{inside}"),
            "rust" => format!("Vec<{inside}>"),
            "python" => format!("List[{inside}]"),
            "java" | "csharp" | "kotlin" => format!("List<{inside}>"),
            "swift" => format!("[{inside}]"),
            "php" => "array".to_string(),
            "dart" => format!("List<{inside}>"),
            _ => {
                if inside.contains(" | ") {
                    format!("({inside})[]")
                } else {
                    format!("{inside}[]")
                }
            }
        };
        if !ty.nullable && !nullable {
            return wrapped;
        }
        return match lang {
            "typescript" | "javascript" => format!("{wrapped} | null"),
            "go" => format!("*{wrapped}"),
            "rust" => format!("Option<{wrapped}>"),
            "python" => format!("Optional[{wrapped}]"),
            "csharp" | "swift" | "kotlin" | "dart" => format!("{wrapped}?"),
            "php" => format!("?{wrapped}"),
            _ => wrapped,
        };
    }
    if ty.kind == CgKind::Union {
        return match lang {
            "typescript" | "javascript" => ty
                .types
                .iter()
                .map(|item| type_base(item, lang, objects, false))
                .collect::<Vec<_>>()
                .join(" | "),
            "python" => format!(
                "Union[{}]",
                ty.types
                    .iter()
                    .map(|item| type_base(item, lang, objects, false))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            "rust" => "serde_json::Value".to_string(),
            "go" => "interface{}".to_string(),
            "swift" => "JSONValue".to_string(),
            "kotlin" => "Any".to_string(),
            _ => "object".to_string(),
        };
    }
    "unknown".to_string()
}

fn ts_type(ty: &CgType, objects: &[CgObject]) -> String {
    type_base(ty, "typescript", objects, false)
}

fn js_doc_type(ty: &CgType, objects: &[CgObject]) -> String {
    let mut base_type = ty.clone();
    base_type.nullable = false;
    let base = type_base(&base_type, "javascript", objects, false);
    if ty.nullable {
        format!("{base}|null")
    } else {
        base
    }
}

fn ts_property_key(key: &str) -> String {
    let mut chars = key.chars();
    let valid = matches!(chars.next(), Some(character) if character.is_ascii_alphabetic() || character == '_' || character == '$')
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '$'
        });
    if valid {
        key.to_string()
    } else {
        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string())
    }
}

fn generate_typescript(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
    javascript: bool,
) -> String {
    let mut lines = vec![format!("// Generated from {source_name}"), String::new()];
    if javascript {
        for index in ordered {
            let object = &objects[*index];
            lines.push("/**".to_string());
            lines.push(format!(" * @typedef {{Object}} {}", object.name));
            for field in &object.fields {
                let optional = if field.required { "" } else { "[" };
                let close = if field.required { "" } else { "]" };
                lines.push(format!(
                    " * @property {{{}}} {}{}{}",
                    js_doc_type(&field.ty, objects),
                    optional,
                    field.key,
                    close
                ));
            }
            lines.push(" */".to_string());
            lines.push(String::new());
        }
        let root_object = root.object_name(objects);
        if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
            lines.push(format!(
                "/** @typedef {{{}}} {} */",
                js_doc_type(root, objects),
                root_name
            ));
            lines.push(String::new());
        }
        lines.push("export {};".to_string());
        return lines.join("\n");
    }
    for index in ordered {
        let object = &objects[*index];
        lines.push(format!("export interface {} {{", object.name));
        let mut used = HashSet::new();
        for field in &object.fields {
            let base = ts_property_key(&field.key);
            let mut name = base.clone();
            let mut suffix = 2;
            while used.contains(&name) {
                name = format!("{base}{suffix}");
                suffix += 1;
            }
            used.insert(name.clone());
            let optional = if field.required { "" } else { "?" };
            lines.push(format!(
                "  {}{}: {};",
                name,
                optional,
                ts_type(&field.ty, objects)
            ));
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        lines.push(format!(
            "export type {} = {};",
            root_name,
            ts_type(root, objects)
        ));
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_go(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![
        format!("// Generated from {source_name}"),
        String::new(),
        "package models".to_string(),
        String::new(),
    ];
    for index in ordered {
        let object = &objects[*index];
        lines.push(format!("type {} struct {{", object.name));
        for (field, name) in object_fields(object, NameStyle::Pascal) {
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "go", objects, false);
            let ty = if field.ty.nullable && base != "interface{}" {
                format!("*{base}")
            } else {
                base
            };
            let tag = if field.required {
                format!("json:\"{}\"", field.key)
            } else {
                format!("json:\"{},omitempty\"", field.key)
            };
            lines.push(format!("\t{name} {ty} `{tag}`"));
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        lines.push(format!(
            "type {} = {}",
            root_name,
            type_base(root, "go", objects, false)
        ));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_rust(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![
        format!("// Generated from {source_name}"),
        String::new(),
        "use serde::{Deserialize, Serialize};".to_string(),
        String::new(),
    ];
    for index in ordered {
        let object = &objects[*index];
        lines.push("#[derive(Clone, Debug, Serialize, Deserialize)]".to_string());
        lines.push(format!("pub struct {} {{", object.name));
        for (field, name) in object_fields(object, NameStyle::Snake) {
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "rust", objects, false);
            let optional = !field.required;
            let ty = if field.ty.nullable || optional {
                format!("Option<{base}>")
            } else {
                base
            };
            if name != field.key {
                lines.push(format!("    #[serde(rename = \"{}\")]", field.key));
            }
            if optional {
                lines.push("    #[serde(skip_serializing_if = \"Option::is_none\")]".to_string());
            }
            lines.push(format!("    pub {name}: {ty},"));
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        lines.push(format!(
            "pub type {} = {};",
            root_name,
            type_base(root, "rust", objects, false)
        ));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_python(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![
        format!("# Generated from {source_name}"),
        "from dataclasses import dataclass".to_string(),
        "from typing import Any, List, Optional, Union".to_string(),
        String::new(),
    ];
    for index in ordered {
        let object = &objects[*index];
        lines.push("@dataclass".to_string());
        lines.push(format!("class {}:", object.name));
        let fields = object_fields(object, NameStyle::Snake);
        let mut rows = Vec::new();
        rows.extend(
            fields
                .iter()
                .filter(|(field, _)| field.required && !field.ty.nullable)
                .cloned(),
        );
        rows.extend(
            fields
                .iter()
                .filter(|(field, _)| !field.required || field.ty.nullable)
                .cloned(),
        );
        if rows.is_empty() {
            lines.push("    pass".to_string());
        }
        for (field, name) in rows {
            let optional = !field.required || field.ty.nullable;
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "python", objects, false);
            if optional {
                lines.push(format!("    {name}: Optional[{base}] = None"));
            } else {
                lines.push(format!("    {name}: {base}"));
            }
        }
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        lines.push(format!(
            "{} = {}",
            root_name,
            type_base(root, "python", objects, false)
        ));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_java(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![
        format!("// Generated from {source_name}"),
        "import java.util.ArrayList;".to_string(),
        "import java.util.List;".to_string(),
        "import java.util.Optional;".to_string(),
        String::new(),
    ];
    for index in ordered {
        let object = &objects[*index];
        lines.push(format!("class {} {{", object.name));
        for (field, name) in object_fields(object, NameStyle::Camel) {
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "java", objects, false);
            if field.required {
                lines.push(format!("    public {base} {name};"));
            } else {
                lines.push(format!(
                    "    public Optional<{base}> {name} = Optional.empty();"
                ));
            }
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        if root.kind == CgKind::Array {
            if let Some(item) = &root.item {
                lines.push(format!(
                    "class {} extends ArrayList<{}> {{",
                    root_name,
                    type_base(item, "java", objects, false)
                ));
                lines.push("}".to_string());
            }
        } else {
            lines.push(format!("class {} {{", root_name));
            lines.push(format!(
                "    public {} value;",
                type_base(root, "java", objects, false)
            ));
            lines.push("}".to_string());
        }
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_csharp(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![
        format!("// Generated from {source_name}"),
        "using System.Collections.Generic;".to_string(),
        String::new(),
    ];
    for index in ordered {
        let object = &objects[*index];
        lines.push(format!("public class {}", object.name));
        lines.push("{".to_string());
        for (field, name) in object_fields(object, NameStyle::Pascal) {
            let nullable = !field.required || field.ty.nullable;
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "csharp", objects, false);
            lines.push(format!(
                "    public {base}{} {name} {{ get; set; }}",
                if nullable { "?" } else { "" }
            ));
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        if root.kind == CgKind::Array {
            if let Some(item) = &root.item {
                lines.push(format!(
                    "public class {} : List<{}> {{ }}",
                    root_name,
                    type_base(item, "csharp", objects, false)
                ));
            }
        } else {
            lines.push(format!("public class {}", root_name));
            lines.push("{".to_string());
            lines.push(format!(
                "    public {} Value {{ get; set; }}",
                type_base(root, "csharp", objects, false)
            ));
            lines.push("}".to_string());
        }
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_swift(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![
        format!("// Generated from {source_name}"),
        "import Foundation".to_string(),
        String::new(),
    ];
    let mut uses_json_value = false;
    for index in ordered {
        let object = &objects[*index];
        lines.push(format!("struct {}: Codable {{", object.name));
        let fields = object_fields(object, NameStyle::Camel);
        for (field, name) in &fields {
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "swift", objects, false);
            if base == "JSONValue" {
                uses_json_value = true;
            }
            let ty = if field.ty.nullable || !field.required {
                format!("{base}?")
            } else {
                base
            };
            lines.push(format!("    let {name}: {ty}"));
        }
        let needs_coding_keys = fields.iter().any(|(field, name)| name != &field.key);
        if needs_coding_keys {
            lines.push(String::new());
            lines.push("    enum CodingKeys: String, CodingKey {".to_string());
            for (field, name) in &fields {
                lines.push(format!("        case {name} = \"{}\"", field.key));
            }
            lines.push("    }".to_string());
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        lines.push(format!(
            "typealias {} = {}",
            root_name,
            type_base(root, "swift", objects, false)
        ));
        lines.push(String::new());
    }
    if uses_json_value {
        lines.extend([
            "enum JSONValue: Codable {".to_string(),
            "    case string(String), number(Double), bool(Bool), null, array([JSONValue]), object([String: JSONValue])".to_string(),
            "    init(from decoder: Decoder) throws {".to_string(),
            "        let container = try decoder.singleValueContainer()".to_string(),
            "        if let value = try? container.decode(String.self) { self = .string(value) }".to_string(),
            "        else if let value = try? container.decode(Double.self) { self = .number(value) }".to_string(),
            "        else if let value = try? container.decode(Bool.self) { self = .bool(value) }".to_string(),
            "        else if container.decodeNil() { self = .null }".to_string(),
            "        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }".to_string(),
            "        else { self = .object(try container.decode([String: JSONValue].self)) }".to_string(),
            "    }".to_string(),
            "    func encode(to encoder: Encoder) throws {".to_string(),
            "        var container = encoder.singleValueContainer()".to_string(),
            "        switch self {".to_string(),
            "        case .string(let value): try container.encode(value)".to_string(),
            "        case .number(let value): try container.encode(value)".to_string(),
            "        case .bool(let value): try container.encode(value)".to_string(),
            "        case .null: try container.encodeNil()".to_string(),
            "        case .array(let value): try container.encode(value)".to_string(),
            "        case .object(let value): try container.encode(value)".to_string(),
            "        }".to_string(),
            "    }".to_string(),
            "}".to_string(),
            String::new(),
        ]);
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_kotlin(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![format!("// Generated from {source_name}"), String::new()];
    for index in ordered {
        let object = &objects[*index];
        let fields = object_fields(object, NameStyle::Camel);
        if fields.is_empty() {
            lines.push(format!("class {}", object.name));
            lines.push(String::new());
            continue;
        }
        lines.push(format!("data class {}(", object.name));
        for (index, (field, name)) in fields.iter().enumerate() {
            let nullable = !field.required || field.ty.nullable;
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "kotlin", objects, false);
            let suffix = if nullable { "? = null" } else { "" };
            lines.push(format!(
                "    val {name}: {base}{suffix}{}",
                if index == fields.len() - 1 { "" } else { "," }
            ));
        }
        lines.push(")".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        lines.push(format!(
            "typealias {} = {}",
            root_name,
            type_base(root, "kotlin", objects, false)
        ));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_php(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![
        "<?php".to_string(),
        format!("// Generated from {source_name}"),
        String::new(),
    ];
    for index in ordered {
        let object = &objects[*index];
        lines.push(format!("class {}", object.name));
        lines.push("{".to_string());
        for (field, name) in object_fields(object, NameStyle::Camel) {
            let nullable = !field.required || field.ty.nullable;
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "php", objects, false);
            let prefix = if nullable && base != "mixed" { "?" } else { "" };
            lines.push(format!(
                "    public {prefix}{base} ${name}{};",
                if nullable { " = null" } else { "" }
            ));
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        if root.kind == CgKind::Array {
            if let Some(item) = &root.item {
                lines.push(format!(
                    "/** @extends \\ArrayObject<int, {}> */",
                    type_base(item, "php", objects, false)
                ));
                lines.push(format!("class {} extends \\ArrayObject {{}}", root_name));
            }
        } else {
            lines.push(format!("class {}", root_name));
            lines.push("{".to_string());
            lines.push(format!(
                "    public {} $value;",
                type_base(root, "php", objects, false)
            ));
            lines.push("}".to_string());
        }
    }
    lines.join("\n").trim_end().to_string()
}

fn generate_dart(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut lines = vec![format!("// Generated from {source_name}"), String::new()];
    for index in ordered {
        let object = &objects[*index];
        let fields = object_fields(object, NameStyle::Camel);
        lines.push(format!("class {} {{", object.name));
        for (field, name) in &fields {
            let nullable = !field.required || field.ty.nullable;
            let mut plain = field.ty.clone();
            plain.nullable = false;
            let base = type_base(&plain, "dart", objects, false);
            lines.push(format!(
                "  {base}{} {name};",
                if nullable && base != "dynamic" {
                    "?"
                } else {
                    ""
                }
            ));
        }
        if !fields.is_empty() {
            lines.push(String::new());
            lines.push(format!("  {}({{", object.name));
            for (field, name) in &fields {
                let required = field.required && !field.ty.nullable;
                lines.push(format!(
                    "    {}this.{name},",
                    if required { "required " } else { "" }
                ));
            }
            lines.push("  });".to_string());
        }
        lines.push("}".to_string());
        lines.push(String::new());
    }
    let root_object = root.object_name(objects);
    if root.kind != CgKind::Object || root_object.as_deref() != Some(root_name) {
        lines.push(format!(
            "typedef {} = {};",
            root_name,
            type_base(root, "dart", objects, false)
        ));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn nullable_primitive(name: &str, nullable: bool) -> Value {
    if nullable {
        json!({ "type": [name, "null"] })
    } else {
        json!({ "type": name })
    }
}

fn schema_for(ty: &CgType, objects: &[CgObject]) -> Value {
    let nullable = ty.nullable;
    let wrap = |value: Value| {
        if nullable {
            json!({ "anyOf": [value, { "type": "null" }] })
        } else {
            value
        }
    };
    match ty.kind {
        CgKind::String => nullable_primitive("string", nullable),
        CgKind::Integer => nullable_primitive("integer", nullable),
        CgKind::Number => nullable_primitive("number", nullable),
        CgKind::Boolean => nullable_primitive("boolean", nullable),
        CgKind::Null => json!({ "type": "null" }),
        CgKind::Object => {
            let name = ty
                .object_name(objects)
                .unwrap_or_else(|| "Nested".to_string());
            wrap(json!({ "$ref": format!("#/$defs/{name}") }))
        }
        CgKind::Array => {
            let items = ty
                .item
                .as_ref()
                .map(|item| schema_for(item, objects))
                .unwrap_or_else(|| json!({}));
            wrap(json!({ "type": "array", "items": items }))
        }
        CgKind::Union => wrap(json!({
            "anyOf": ty.types.iter().map(|item| schema_for(item, objects)).collect::<Vec<_>>()
        })),
        CgKind::Unknown => {
            if nullable {
                json!({ "anyOf": [{}, { "type": "null" }] })
            } else {
                json!({})
            }
        }
    }
}

fn generate_json_schema(
    objects: &[CgObject],
    ordered: &[usize],
    root: &CgType,
    root_name: &str,
    source_name: &str,
) -> String {
    let mut definitions = Map::new();
    for index in ordered {
        let object = &objects[*index];
        let mut properties = Map::new();
        let mut required = Vec::new();
        for field in &object.fields {
            properties.insert(field.key.clone(), schema_for(&field.ty, objects));
            if field.required {
                required.push(Value::String(field.key.clone()));
            }
        }
        let mut schema = Map::new();
        schema.insert("type".to_string(), Value::String("object".to_string()));
        schema.insert("properties".to_string(), Value::Object(properties));
        schema.insert("additionalProperties".to_string(), Value::Bool(false));
        if !required.is_empty() {
            schema.insert("required".to_string(), Value::Array(required));
        }
        definitions.insert(object.name.clone(), Value::Object(schema));
    }
    if !definitions.contains_key(root_name) {
        definitions.insert(root_name.to_string(), schema_for(root, objects));
    }
    let mut document = Map::new();
    document.insert(
        "$schema".to_string(),
        Value::String("https://json-schema.org/draft/2020-12/schema".to_string()),
    );
    document.insert("title".to_string(), Value::String(root_name.to_string()));
    document.insert(
        "description".to_string(),
        Value::String(format!("Generated from {source_name}")),
    );
    document.insert(
        "$ref".to_string(),
        Value::String(format!("#/$defs/{root_name}")),
    );
    document.insert("$defs".to_string(), Value::Object(definitions));
    serde_json::to_string_pretty(&Value::Object(document)).unwrap_or_default()
}

fn file_for(lang: &str, root_name: &str, extension: &str) -> String {
    if lang == "schema" {
        return format!("{}.schema.json", kebab(root_name));
    }
    if matches!(lang, "java" | "csharp" | "swift" | "kotlin") {
        return format!("{root_name}.{extension}");
    }
    let base = if matches!(lang, "go" | "rust" | "python") {
        snake(root_name)
    } else {
        kebab(root_name)
    };
    format!("{base}.{extension}")
}

fn root_summary(root: &CgType, root_name: &str, objects: &[CgObject]) -> String {
    if root.kind == CgKind::Object {
        let object = if let Some(index) = root.object {
            objects.get(index)
        } else {
            root.object_clone.as_deref()
        };
        if let Some(object) = object {
            let mut parts = vec![root_name.to_string()];
            for field in object.fields.iter().take(3) {
                parts.push(format!(
                    "{}: {}",
                    field.key,
                    ts_type(&field.ty, objects).replace(" | null", "")
                ));
            }
            return parts.join(" · ");
        }
    }
    if root.kind == CgKind::Array {
        if let Some(item) = &root.item {
            return format!("{root_name} · {}[]", ts_type(item, objects));
        }
    }
    format!("{root_name} · {}", ts_type(root, objects))
}

fn build_generated(lang: &str, value: &Value, file_name: &str, extension: &str) -> GeneratedCode {
    let stem = file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name);
    let root_name = pascal(stem);
    let mut ctx = CgContext::default();
    let root = infer(value, &root_name, &mut ctx);
    let ordered = ordered_objects(&ctx);
    let source_name = file_name;
    let code = match lang {
        "javascript" => {
            generate_typescript(&ctx.objects, &ordered, &root, &root_name, source_name, true)
        }
        "typescript" => generate_typescript(
            &ctx.objects,
            &ordered,
            &root,
            &root_name,
            source_name,
            false,
        ),
        "go" => generate_go(&ctx.objects, &ordered, &root, &root_name, source_name),
        "rust" => generate_rust(&ctx.objects, &ordered, &root, &root_name, source_name),
        "python" => generate_python(&ctx.objects, &ordered, &root, &root_name, source_name),
        "java" => generate_java(&ctx.objects, &ordered, &root, &root_name, source_name),
        "csharp" => generate_csharp(&ctx.objects, &ordered, &root, &root_name, source_name),
        "swift" => generate_swift(&ctx.objects, &ordered, &root, &root_name, source_name),
        "kotlin" => generate_kotlin(&ctx.objects, &ordered, &root, &root_name, source_name),
        "php" => generate_php(&ctx.objects, &ordered, &root, &root_name, source_name),
        "schema" => generate_json_schema(&ctx.objects, &ordered, &root, &root_name, source_name),
        _ => generate_dart(&ctx.objects, &ordered, &root, &root_name, source_name),
    };
    let records = match value {
        Value::Array(items) => items.len() as u64,
        Value::Object(map) => map
            .values()
            .filter_map(|item| match item {
                Value::Array(items) => Some(items.len() as u64),
                _ => None,
            })
            .max()
            .unwrap_or(0)
            .max(1),
        _ => 1,
    };
    GeneratedCode {
        code,
        file: file_for(lang, &root_name, extension),
        root_label: root_summary(&root, &root_name, &ctx.objects),
        root_name,
        types: ordered.len(),
        records,
    }
}

pub fn generate(
    text: &str,
    language: &str,
    file_name: &str,
    extension: &str,
) -> Result<GeneratedCode, String> {
    if text.trim().is_empty() {
        return Ok(GeneratedCode {
            code: "// Open a JSON document to generate types.".to_string(),
            file: format!("model.{extension}"),
            root_name: String::new(),
            types: 0,
            records: 0,
            root_label: "No document".to_string(),
        });
    }
    let value = match serde_json::from_str::<Value>(text) {
        Ok(value) => value,
        Err(_) => {
            return Ok(GeneratedCode {
                code: "// The document is not valid JSON. Fix the syntax to generate types."
                    .to_string(),
                file: format!("model.{extension}"),
                root_name: String::new(),
                types: 0,
                records: 0,
                root_label: "Invalid JSON".to_string(),
            });
        }
    };
    Ok(build_generated(language, &value, file_name, extension))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_typescript_reference_output() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../tests/fixtures/codegen_sample_catalog.json"
        ))
        .expect("fixture");
        let name = fixture["name"].as_str().expect("name");
        let input = serde_json::to_string(&fixture["data"]).expect("input");
        let expected_types = fixture["types"].as_u64().expect("types") as usize;
        let expected_records = fixture["records"].as_u64().expect("records");
        for (language, expected) in fixture["languages"].as_object().expect("languages") {
            let extension = expected["ext"].as_str().expect("ext");
            let generated = generate(&input, language, name, extension).expect("generate");
            assert_eq!(generated.types, expected_types, "{language} types");
            assert_eq!(generated.records, expected_records, "{language} records");
            assert_eq!(
                generated.file,
                expected["file"].as_str().expect("file"),
                "{language} file"
            );
            assert_eq!(
                generated.root_label,
                expected["root"].as_str().expect("root"),
                "{language} root"
            );
            if generated.code != expected["code"].as_str().expect("code") {
                let actual_lines: Vec<&str> = generated.code.lines().collect();
                let expected_lines: Vec<&str> =
                    expected["code"].as_str().unwrap().lines().collect();
                for index in 0..actual_lines.len().max(expected_lines.len()) {
                    let actual = actual_lines.get(index).copied().unwrap_or("<missing>");
                    let expected = expected_lines.get(index).copied().unwrap_or("<missing>");
                    if actual != expected {
                        panic!("{language} differs at line {}:\nactual:   {actual:?}\nexpected: {expected:?}", index + 1);
                    }
                }
                panic!("{language} code differs");
            }
        }
    }

    #[test]
    fn handles_empty_and_invalid_documents() {
        let empty = generate("  ", "typescript", "empty.json", "ts").expect("empty");
        assert_eq!(empty.file, "model.ts");
        assert_eq!(empty.types, 0);
        assert_eq!(empty.root_label, "No document");
        let invalid = generate("{", "rust", "broken.json", "rs").expect("invalid");
        assert_eq!(invalid.file, "model.rs");
        assert_eq!(invalid.root_label, "Invalid JSON");
    }
}
