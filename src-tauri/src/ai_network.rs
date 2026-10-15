//! One network policy for native provider requests and the packaged Node host.
use crate::models::{AiNetworkSettings, AiProxyMode};
use anyhow::{bail, Context, Result};
use hyper_util::client::proxy::matcher::Matcher;
use reqwest::blocking::ClientBuilder;
use std::ffi::OsString;
use tokio::process::Command;

#[derive(Clone, Default)]
pub(crate) struct ResolvedAiNetwork {
    pub mode: AiProxyMode,
    /// May include proxy credentials. Never expose this in settings snapshots.
    pub proxy_url: Option<String>,
}

impl std::fmt::Debug for ResolvedAiNetwork {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedAiNetwork")
            .field("mode", &self.mode)
            .field("proxy_configured", &self.proxy_url.is_some())
            .finish()
    }
}

pub(crate) fn validate_settings(settings: &AiNetworkSettings) -> Result<()> {
    match settings.mode {
        AiProxyMode::Custom => {
            let value = settings.proxy_url.as_deref().unwrap_or("");
            let url = reqwest::Url::parse(value).context("Enter a valid proxy URL")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                bail!("Proxy URL must be an HTTP or HTTPS host and optional port without credentials or a path");
            }
        }
        AiProxyMode::System | AiProxyMode::Direct => {
            if settings.proxy_url.is_some() {
                bail!("Proxy URL is only valid in custom proxy mode");
            }
        }
    }
    Ok(())
}

pub(crate) fn client_builder(settings: &ResolvedAiNetwork) -> Result<ClientBuilder> {
    Ok(match settings.mode {
        AiProxyMode::System => ClientBuilder::new(),
        AiProxyMode::Direct => ClientBuilder::new().no_proxy(),
        AiProxyMode::Custom => ClientBuilder::new()
            .no_proxy()
            .proxy(reqwest::Proxy::all(settings.proxy_url.as_deref().unwrap())?),
    })
}

fn proxy_from_matcher(matcher: &Matcher, target: &str) -> Result<Option<String>> {
    let uri: http::Uri = target.parse().context("Invalid AI provider URL")?;
    let intercept = matcher.intercept(&uri);
    let Some(intercept) = intercept else {
        return Ok(None);
    };
    // An environment URL can contain proxy credentials. Keep its original
    // spelling when it selects this intercept; Intercept::uri strips userinfo.
    let names: &[&str] = match uri.scheme_str() {
        Some("http") => &["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"],
        Some("https") => &["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"],
        _ => return Ok(None),
    };
    for name in names {
        let Some(raw) = std::env::var(name).ok() else {
            continue;
        };
        let candidate = match uri.scheme_str() {
            Some("http") => Matcher::builder().http(raw.clone()).build(),
            Some("https") => Matcher::builder().https(raw.clone()).build(),
            _ => unreachable!(),
        };
        if candidate.intercept(&uri).is_some_and(|found| {
            found.uri() == intercept.uri()
                && found.basic_auth() == intercept.basic_auth()
                && found.raw_auth() == intercept.raw_auth()
        }) {
            return Ok(Some(raw));
        }
    }
    Ok(Some(intercept.uri().to_string()))
}

/// Apply the exact decision for this provider host. Clearing inherited proxy
/// and bypass variables prevents Node from making a different decision.
pub(crate) fn configure_node(
    command: &mut Command,
    target: &str,
    settings: &ResolvedAiNetwork,
) -> Result<()> {
    let provider_url = reqwest::Url::parse(target).context("Invalid AI provider URL")?;
    if !matches!(provider_url.scheme(), "http" | "https") || provider_url.host_str().is_none() {
        bail!("AI provider URL must use HTTP or HTTPS");
    }
    let (http_proxy, https_proxy) = match settings.mode {
        AiProxyMode::System => {
            let matcher = Matcher::from_system();
            let mut http_url = provider_url.clone();
            let mut https_url = provider_url;
            http_url
                .set_scheme("http")
                .map_err(|_| anyhow::anyhow!("Invalid AI provider URL"))?;
            https_url
                .set_scheme("https")
                .map_err(|_| anyhow::anyhow!("Invalid AI provider URL"))?;
            (
                proxy_from_matcher(&matcher, http_url.as_str())?,
                proxy_from_matcher(&matcher, https_url.as_str())?,
            )
        }
        AiProxyMode::Custom => (settings.proxy_url.clone(), settings.proxy_url.clone()),
        AiProxyMode::Direct => (None, None),
    };
    for name in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ] {
        command.env_remove(name);
    }
    for (name, proxy) in [("HTTP_PROXY", http_proxy), ("HTTPS_PROXY", https_proxy)] {
        if let Some(proxy) = proxy {
            command.env(name, OsString::from(&proxy));
            command.env(name.to_ascii_lowercase(), proxy);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AiNetworkSettings, AiProxyMode};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn settings(mode: AiProxyMode, proxy_url: Option<String>) -> ResolvedAiNetwork {
        ResolvedAiNetwork { mode, proxy_url }
    }

    fn one_response() -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let task = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut bytes = [0u8; 2048];
            let mut count = 0;
            while !bytes[..count].windows(4).any(|part| part == b"\r\n\r\n") {
                let read = stream.read(&mut bytes[count..]).unwrap();
                assert!(read > 0);
                count += read;
                assert!(count < bytes.len());
            }
            let request = String::from_utf8_lossy(&bytes[..count]).into_owned();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
            request
        });
        (address, task)
    }

    #[test]
    fn matcher_respects_destination_scheme_and_bypass() {
        let matcher = Matcher::builder()
            .http("http://127.0.0.1:8001")
            .https("http://127.0.0.1:8002")
            .no("internal.example")
            .build();
        assert_eq!(
            proxy_from_matcher(&matcher, "http://api.example/v1").unwrap(),
            Some("http://127.0.0.1:8001/".into())
        );
        assert_eq!(
            proxy_from_matcher(&matcher, "https://api.example/v1").unwrap(),
            Some("http://127.0.0.1:8002/".into())
        );
        assert_eq!(
            proxy_from_matcher(&matcher, "https://internal.example/v1").unwrap(),
            None
        );
    }

    #[test]
    fn custom_proxy_rejects_unsupported_or_credentialed_urls() {
        for url in [
            "socks5://localhost:1080",
            "http://user:password@localhost:8080",
            "http://localhost:8080/other",
            "http://localhost:8080?token=secret",
        ] {
            assert!(
                validate_settings(&AiNetworkSettings {
                    mode: AiProxyMode::Custom,
                    proxy_url: Some(url.into()),
                    ..Default::default()
                })
                .is_err(),
                "{url}"
            );
        }
        assert!(validate_settings(&AiNetworkSettings {
            mode: AiProxyMode::Custom,
            proxy_url: Some("http://localhost:8080".into()),
            ..Default::default()
        })
        .is_ok());
    }

    #[test]
    fn node_custom_sets_both_schemes_and_direct_removes_them() {
        let mut command = Command::new("node");
        command.env("ALL_PROXY", "http://inherited:9000");
        configure_node(
            &mut command,
            "https://api.example/v1",
            &settings(AiProxyMode::Custom, Some("http://127.0.0.1:8080".into())),
        )
        .unwrap();
        let env: std::collections::HashMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(env["HTTP_PROXY"].as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(env["HTTPS_PROXY"].as_deref(), Some("http://127.0.0.1:8080"));
        assert_eq!(env["ALL_PROXY"], None);
        configure_node(
            &mut command,
            "https://api.example/v1",
            &settings(AiProxyMode::Direct, None),
        )
        .unwrap();
        let env: std::collections::HashMap<_, _> = command
            .as_std()
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(env["HTTP_PROXY"], None);
        assert_eq!(env["HTTPS_PROXY"], None);
    }

    #[test]
    fn native_custom_proxy_routes_and_does_not_fall_back() {
        let (proxy, seen) = one_response();
        let origin = TcpListener::bind("127.0.0.1:0").unwrap();
        origin.set_nonblocking(true).unwrap();
        let target = format!("http://{}/v1", origin.local_addr().unwrap());
        let custom = settings(AiProxyMode::Custom, Some(proxy));
        let client = client_builder(&custom)
            .unwrap()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(client.get(&target).send().unwrap().text().unwrap(), "ok");
        assert!(seen.join().unwrap().starts_with(&format!("GET {target} ")));
        assert_eq!(
            origin.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let unreachable = settings(AiProxyMode::Custom, Some("http://127.0.0.1:1".into()));
        let client = client_builder(&unreachable)
            .unwrap()
            .timeout(std::time::Duration::from_secs(2))
            .build()
            .unwrap();
        assert!(client.get(&target).send().is_err());
        assert_eq!(
            origin.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn native_direct_ignores_ambient_proxy() {
        let (target, seen) = one_response();
        let client = client_builder(&settings(AiProxyMode::Direct, None))
            .unwrap()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(
            client
                .get(format!("{target}/v1"))
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        assert!(seen.join().unwrap().starts_with("GET /v1 "));
    }

    #[test]
    fn native_https_uses_proxy_connect() {
        let (proxy, seen) = one_response();
        let client = client_builder(&settings(AiProxyMode::Custom, Some(proxy)))
            .unwrap()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        assert!(client.get("https://127.0.0.1:1/v1").send().is_err());
        assert!(seen.join().unwrap().starts_with("CONNECT 127.0.0.1:1 "));
    }

    #[test]
    fn native_custom_proxy_sends_basic_auth() {
        let (proxy, seen) = one_response();
        let mut url = reqwest::Url::parse(&proxy).unwrap();
        url.set_username("agent").unwrap();
        url.set_password(Some("secret")).unwrap();
        let client = client_builder(&settings(AiProxyMode::Custom, Some(url.to_string())))
            .unwrap()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(
            client
                .get("http://127.0.0.1:1/v1")
                .send()
                .unwrap()
                .text()
                .unwrap(),
            "ok"
        );
        assert!(seen
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("proxy-authorization: basic ywdlbnq6c2vjcmv0"));
    }
}
