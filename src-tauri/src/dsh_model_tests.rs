use super::*;
use serde_json::json;
use std::time::Duration;

fn profile() -> ResolvedAiProfile {
    ResolvedAiProfile {
        profile_name: "fixture".into(),
        provider_family: "openai_compatible".into(),
        base_url: "https://example.invalid/v1".into(),
        api_key: "fixture-secret".into(),
        model: "fixture-model".into(),
        supports_text: true,
        supports_image: false,
        network: crate::ai_network::ResolvedAiNetwork {
            mode: crate::models::AiProxyMode::Direct,
            proxy_url: None,
        },
    }
}

#[test]
fn one_shot_request_preserves_model_identity_and_omits_capacity_credentials() {
    let profile = profile();
    let capacity = request("capacity", &profile, json!({})).unwrap();
    let capacity: Value = serde_json::from_slice(&capacity.0).unwrap();
    assert_eq!(capacity["operation"], "capacity");
    assert_eq!(capacity["modelId"], profile.model);
    assert_eq!(capacity["profile"]["defaultModel"], profile.model);
    assert_eq!(capacity["profile"]["baseUrl"], profile.base_url);
    assert!(capacity.get("apiKey").is_none());
    for operation in ["generate", "probe"] {
        let frame = request(operation, &profile, json!({})).unwrap();
        let frame: Value = serde_json::from_slice(&frame.0).unwrap();
        assert_eq!(frame["apiKey"], "fixture-secret");
        assert!(frame.get("workspaceRoot").is_none());
        assert!(frame.get("sessionId").is_none());
    }
    assert_eq!(
        request(
            "generate",
            &profile,
            json!({"prompt":"x".repeat(MAX_REQUEST_BYTES)})
        )
        .err()
        .unwrap()
        .code,
        ErrorCode::BudgetExceeded
    );
}

#[test]
fn one_shot_response_rejects_extra_frames_invalid_shapes_and_scrubs_provider_errors() {
    assert_eq!(
        response(br#"{"ok":true,"data":{"text":"{}","usage":{}}}"#).unwrap()["text"],
        "{}"
    );
    for invalid in [
        "{}",
        "null",
        r#"{"ok":"true","data":{}}"#,
        r#"{"ok":true,"data":[]}"#,
        "{\"ok\":true,\"data\":{}}\n{\"ok\":true,\"data\":{}}",
        "not-json",
    ] {
        assert_eq!(
            response(invalid.as_bytes()).unwrap_err().code,
            ErrorCode::RuntimeIncompatible
        );
    }
    for (remote, expected) in [
        ("RATE_LIMITED", ErrorCode::RateLimited),
        ("RUN_CANCELLED", ErrorCode::Cancelled),
        ("MODEL_FAILED", ErrorCode::RuntimeUnavailable),
        ("TOOL_CALL_UNSUPPORTED", ErrorCode::ToolCallUnsupported),
        ("UNKNOWN", ErrorCode::RuntimeIncompatible),
    ] {
        let error = response(
            &serde_json::to_vec(
                &json!({"ok":false,"error":{"code":remote,"message":"fixture-secret"}}),
            )
            .unwrap(),
        )
        .unwrap_err();
        assert_eq!(error.code, expected);
        assert!(!error.message.contains("fixture-secret"));
    }
}

fn checksum(path: &Path) -> Value {
    json!(crate::db::file_versions::checksum(path)
        .unwrap()
        .strip_prefix("sha256:")
        .unwrap())
}

fn distribution() -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("dsh-assistant");
    let node_root = temp.path().join("agent-host");
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::create_dir(&node_root).unwrap();
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    let node = node_root.join(node_name);
    fs::write(&node, "fixture runtime").unwrap();
    let pinned: Value = serde_json::from_str(PINNED_NODE).unwrap();
    let target = target().unwrap();
    let receipt = json!({"target":target,"nodeVersion":pinned["nodeVersion"],"sourceArchive":pinned["targets"][target]["archive"],
        "sourceArchiveChecksum":pinned["targets"][target]["sha256"],"nodeChecksum":checksum(&node)});
    fs::write(
        node_root.join("runtime.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    for name in [
        "scripts/runtime.mjs",
        "scripts/model-utility-entry.mjs",
        "package.json",
        "package-lock.json",
        "DSH-THIRD-PARTY-NOTICES.txt",
    ] {
        fs::write(root.join(name), "fixture").unwrap();
    }
    fs::write(
        root.join("upstream.json"),
        include_str!("../../packages/dsh-assistant/upstream.json"),
    )
    .unwrap();
    let mut files = HashSet::new();
    inventory(&root, "", &mut files).unwrap();
    let files: Vec<_> = files
        .iter()
        .map(|name| json!({"file":name,"checksum":checksum(&root.join(name))}))
        .collect();
    let manifest = json!({"schemaVersion":1,"target":target,"entry":"scripts/runtime.mjs","installAnchor":"package.json",
        "node":{"executable":format!("../agent-host/{node_name}"),"version":receipt["nodeVersion"],"checksum":receipt["nodeChecksum"]},
        "packages":[{"name":"fixture"}],"files":files,
        "lockfileChecksum":checksum(&root.join("package-lock.json")),"noticesChecksum":checksum(&root.join("DSH-THIRD-PARTY-NOTICES.txt"))});
    fs::write(
        root.join("dsh-distribution.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    temp
}

#[test]
fn packaged_model_runtime_requires_exact_dsh_inventory_and_pinned_node_receipt() {
    let temp = distribution();
    assert!(ModelRuntime::bundled(temp.path()).is_ok());
    fs::write(
        temp.path()
            .join("dsh-assistant/scripts/model-utility-entry.mjs"),
        "changed",
    )
    .unwrap();
    assert_eq!(
        ModelRuntime::bundled(temp.path()).err().unwrap().code,
        ErrorCode::RuntimeUnavailable
    );
    let temp = distribution();
    fs::write(temp.path().join("dsh-assistant/extra.mjs"), "unreceipted").unwrap();
    assert!(ModelRuntime::bundled(temp.path()).is_err());
    let temp = distribution();
    fs::write(
        temp.path()
            .join("agent-host")
            .join(if cfg!(windows) { "node.exe" } else { "node" }),
        "replaced",
    )
    .unwrap();
    assert!(ModelRuntime::bundled(temp.path()).is_err());
}

#[cfg(unix)]
#[test]
fn packaged_model_runtime_rejects_symlinks_and_inventory_path_escapes() {
    let temp = distribution();
    std::os::unix::fs::symlink(
        "runtime.mjs",
        temp.path().join("dsh-assistant/scripts/alias.mjs"),
    )
    .unwrap();
    assert!(ModelRuntime::bundled(temp.path()).is_err());
    for relative in [
        "../escape",
        "/absolute",
        "scripts/../escape",
        "scripts\\escape",
        "C:/escape",
        "scripts//entry",
    ] {
        assert!(!valid_path(relative));
    }
}

// A minimal executable stands in for Node so lifecycle tests do not depend on
// staged dependencies, the provider network, or another worker's build cache.
#[cfg(unix)]
fn process_fixture(body: &str) -> (tempfile::TempDir, ModelRuntime) {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let node = temp.path().join("fixture-node");
    fs::write(&node, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = ModelRuntime {
        root: temp.path().to_owned(),
        node,
    };
    (temp, runtime)
}

#[cfg(unix)]
#[tokio::test]
async fn one_shot_process_closes_stdin_and_clears_sent_credential() {
    let (_temp, runtime) = process_fixture("request=$(/bin/cat)\ncase \"$request\" in *fixture-secret*) ;; *) exit 1 ;; esac\nprintf '%s' '{\"ok\":true,\"data\":{\"toolCallingVerified\":true}}'");
    let mut profile = profile();
    let data = runtime
        .call(
            "probe",
            &mut profile,
            json!({}),
            Instant::now() + Duration::from_secs(5),
            None,
        )
        .await
        .unwrap();
    assert_eq!(data["toolCallingVerified"], true);
    assert!(profile.api_key.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn one_shot_process_cancellation_and_deadline_kill_the_child() {
    for cancel_request in [true, false] {
        let (temp, runtime) = process_fixture(
            "/bin/cat >/dev/null\nprintf '%s' \"$$\" > started\nexec /bin/sleep 30",
        );
        // Child cwd is private; use a fixture marker at an absolute path.
        let marker = temp.path().join("started");
        let body = format!(
            "/bin/cat >/dev/null\nprintf '%s' \"$$\" > '{}'\nexec /bin/sleep 30",
            marker.display()
        );
        fs::write(&runtime.node, format!("#!/bin/sh\n{body}\n")).unwrap();
        let (sender, mut receiver) = watch::channel(false);
        let mut profile = profile();
        let deadline =
            Instant::now() + Duration::from_millis(if cancel_request { 5000 } else { 500 });
        let call = runtime.call(
            "probe",
            &mut profile,
            json!({}),
            deadline,
            Some(&mut receiver),
        );
        let signal = async {
            tokio::time::timeout(Duration::from_secs(3), async {
                while !marker.exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            if cancel_request {
                sender.send(true).unwrap();
            }
        };
        let (result, ()) = tokio::join!(call, signal);
        assert_eq!(
            result.unwrap_err().code,
            if cancel_request {
                ErrorCode::Cancelled
            } else {
                ErrorCode::TimedOut
            }
        );
        assert!(profile.api_key.is_empty());
        let pid: i32 = fs::read_to_string(marker).unwrap().parse().unwrap();
        assert!(
            !std::process::Command::new("/bin/kill")
                .args(["-0", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success(),
            "child must be reaped before returning"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn one_shot_process_bounds_stdout_and_rejects_unsuccessful_exit() {
    for body in [
        "/bin/cat >/dev/null\n/usr/bin/head -c 1048577 /dev/zero",
        "/bin/cat >/dev/null\nprintf '%s' '{\"ok\":true,\"data\":{}}'\nexit 1",
    ] {
        let (_temp, runtime) = process_fixture(body);
        let mut profile = profile();
        let error = runtime
            .call(
                "capacity",
                &mut profile,
                json!({}),
                Instant::now() + Duration::from_secs(5),
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::RuntimeIncompatible);
    }
}

#[test]
fn distribution_receipt_larger_than_four_mib_remains_bounded_and_validates() {
    let temp = distribution();
    let path = temp.path().join("dsh-assistant/dsh-distribution.json");
    let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    // A production dependency/license inventory is ~5.5 MB. Exercise the full
    // bundled validator with the same kind of repeated package provenance.
    manifest["packages"] =
        json!((0..35_000).map(|i| json!({
        "name":format!("@distribution/dependency-{i:05}"), "version":"1.2.3", "license":"MIT",
        "licenseFile":format!("node_modules/@distribution/dependency-{i:05}/LICENSE"),
        "checksum":"a".repeat(64),
    })).collect::<Vec<_>>());
    let bytes = serde_json::to_vec(&manifest).unwrap();
    assert!(bytes.len() > 5_523_192);
    assert!(bytes.len() < DISTRIBUTION_MANIFEST_BYTES);
    fs::write(&path, bytes).unwrap();
    assert!(ModelRuntime::bundled(temp.path()).is_ok());
    assert!(regular_json(&path, METADATA_BYTES).is_err());
    let oversized = temp.path().join("oversized.json");
    let file = fs::File::create(&oversized).unwrap();
    file.set_len(DISTRIBUTION_MANIFEST_BYTES as u64 + 1)
        .unwrap();
    assert!(regular_json(&oversized, DISTRIBUTION_MANIFEST_BYTES).is_err());
}

#[tokio::test]
#[ignore = "requires prepared pinned Node and staged DSH production resources"]
async fn staged_distribution_validates() {
    let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
    let manifest_path = resources.join("dsh-assistant/dsh-distribution.json");
    let manifest = regular_json(&manifest_path, DISTRIBUTION_MANIFEST_BYTES).unwrap();
    let inventory = manifest["files"].as_array().unwrap();
    assert!(inventory
        .iter()
        .any(|file| file["file"] == "scripts/model-utility-entry.mjs"));
    assert!(inventory.iter().any(|file| file["file"]
        .as_str()
        .is_some_and(|name| name.starts_with("node_modules/@deepseek-ai/dsh-llm/"))));
    let runtime = ModelRuntime::bundled(&resources).unwrap();
    let mut official_catalog_profile = profile();
    // Match the positive catalog fixture in model-utility.test.mjs.
    official_catalog_profile.base_url = "https://api.openai.com/v1".into();
    official_catalog_profile.model = "gpt-4o".into();
    official_catalog_profile.api_key.clear();
    let capacity = runtime
        .call(
            "capacity",
            &mut official_catalog_profile,
            json!({}),
            Instant::now() + Duration::from_secs(60),
            None,
        )
        .await
        .unwrap();
    assert!(capacity["inputBytes"]
        .as_u64()
        .is_some_and(|n| n > 0 && n <= 2 * 1024 * 1024));
    assert!(capacity["outputTokens"]
        .as_u64()
        .is_some_and(|n| n > 0 && n <= 4096));
    assert_eq!(capacity["contextWindow"], 128000);
    assert_eq!(capacity["outputTokens"], 4096);
    assert!(capacity["maxTokens"].as_u64().is_some_and(|n| n >= 4096));
    assert_eq!(capacity["source"], "dsh-catalog");
    assert!(official_catalog_profile.api_key.is_empty());
}
