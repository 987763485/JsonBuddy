use reqwest::{Method, Url};
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRequestResult {
    pub status: u16,
    pub status_text: String,
    pub duration_ms: u64,
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

pub(crate) fn validate_local_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|error| format!("invalid request URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http and https requests are allowed".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials are not allowed in mock request URLs".to_string());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "mock request URL has no host".to_string())?;
    if !is_loopback_host(host) {
        return Err("mock requests are limited to localhost".to_string());
    }
    if host.eq_ignore_ascii_case("localhost") {
        url.set_host(Some("127.0.0.1"))
            .map_err(|_| "could not normalize the localhost request URL".to_string())?;
    }
    Ok(url)
}

pub async fn send_local_request(raw_url: &str, method: &str) -> Result<LocalRequestResult, String> {
    let url = validate_local_url(raw_url)?;
    let method = Method::from_bytes(method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| "unsupported HTTP method".to_string())?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("could not create request client: {error}"))?;
    let started = Instant::now();
    let response = client
        .request(method, url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status();
    let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    Ok(LocalRequestResult {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_loopback_urls() {
        let localhost = validate_local_url("http://localhost:4010/api/items").expect("localhost");
        assert_eq!(localhost.host_str(), Some("127.0.0.1"));
        let ipv4 = validate_local_url("https://127.0.0.1:4010/health").expect("ipv4");
        assert_eq!(ipv4.host_str(), Some("127.0.0.1"));
        let ipv6 = validate_local_url("http://[::1]:4010/items").expect("ipv6");
        assert_eq!(ipv6.host_str(), Some("[::1]"));
    }

    #[test]
    fn rejects_remote_and_unsupported_urls() {
        assert!(validate_local_url("https://example.com/items").is_err());
        assert!(validate_local_url("file:///tmp/items.json").is_err());
        assert!(validate_local_url("http://user:pass@localhost:4010/items").is_err());
        assert!(validate_local_url("http://localhost.evil.test/items").is_err());
    }

    #[tokio::test]
    async fn accepts_self_signed_localhost_https() {
        use axum::routing::get;
        use axum::Router;
        use axum_server::tls_rustls::RustlsConfig;
        use axum_server::Handle;
        use std::net::TcpListener;

        let generated =
            rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).expect("certificate");
        let config = RustlsConfig::from_pem(
            generated.cert.pem().into_bytes(),
            generated.signing_key.serialize_pem().into_bytes(),
        )
        .await
        .expect("TLS config");
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        listener
            .set_nonblocking(true)
            .expect("nonblocking listener");
        let address = listener.local_addr().expect("address");
        let handle = Handle::new();
        let server_handle = handle.clone();
        let join = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                let app = Router::new().route("/health", get(|| async { "ok" }));
                axum_server::from_tcp_rustls(listener, config)
                    .expect("server")
                    .handle(server_handle)
                    .serve(app.into_make_service())
                    .await
                    .expect("serve");
            });
        });
        tokio::time::sleep(Duration::from_millis(120)).await;
        let result = send_local_request(
            &format!("https://127.0.0.1:{}/health", address.port()),
            "GET",
        )
        .await
        .expect("self-signed HTTPS request");
        handle.graceful_shutdown(Some(Duration::from_millis(50)));
        let _ = join.join();
        assert_eq!(result.status, 200);
        assert_eq!(result.status_text, "OK");
    }
}
