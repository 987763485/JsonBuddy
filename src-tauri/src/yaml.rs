use serde_json::Value;

const MAX_YAML_BYTES: usize = 10 * 1024 * 1024;

/// Parses a YAML document into a JSON value for the mock import bridge.
pub fn parse_yaml_document(text: &str) -> Result<Value, String> {
    if text.len() > MAX_YAML_BYTES {
        return Err("YAML document is larger than the 10 MB import limit".to_string());
    }
    serde_yaml::from_str::<Value>(text)
        .map_err(|error| format!("could not parse YAML: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openapi_yaml() {
        let text = r#"
openapi: 3.1.0
info:
  title: Pets API
paths:
  /pets:
    get:
      summary: List pets
      responses:
        '200':
          content:
            application/json:
              examples:
                first:
                  value:
                    - id: 1
                      name: Ada
"#;
        let value = parse_yaml_document(text).expect("yaml should parse");
        assert_eq!(value["openapi"], "3.1.0");
        assert_eq!(value["info"]["title"], "Pets API");
        assert_eq!(value["paths"]["/pets"]["get"]["responses"]["200"]["content"]
            ["application/json"]["examples"]["first"]["value"][0]["name"], "Ada");
    }

    #[test]
    fn rejects_invalid_yaml() {
        let error = parse_yaml_document("openapi: [").expect_err("yaml should fail");
        assert!(error.contains("could not parse YAML"));
    }

    #[test]
    fn rejects_oversized_yaml() {
        let text = "a".repeat(MAX_YAML_BYTES + 1);
        let error = parse_yaml_document(&text).expect_err("yaml should be rejected");
        assert!(error.contains("10 MB"));
    }
}
