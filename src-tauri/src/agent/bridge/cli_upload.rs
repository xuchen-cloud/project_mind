//! Local File upload orchestration. Only bytes and native DTOs cross the bridge;
//! the body file path remains in this process.
use crate::agent::{
    bridge::client::BridgeClient,
    errors::{AgentError, AgentResult, ErrorCode},
    models::{ObjectKind, ObjectRef, WorkspaceBinding},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;

const MAX_BODY: u64 = 100 * 1024 * 1024;
const CHUNK: usize = 1024 * 1024;

fn invalid(message: &'static str) -> AgentError { AgentError::new(ErrorCode::InvalidArgument, message) }
fn incompatible() -> AgentError { AgentError::new(ErrorCode::RuntimeIncompatible, "Invalid File upload response") }
pub(super) fn valid_hash(value: &str) -> bool {
    value.len() == 71 && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FileUploadTargetInput {
    object: ObjectRef,
    expected_version_number: u32,
    expected_content_hash: String,
}

pub(super) fn decode_target(value: Value) -> AgentResult<FileUploadTargetInput> {
    let target: FileUploadTargetInput = serde_json::from_value(value)
        .map_err(|_| invalid("--input-file must contain a File upload target"))?;
    target.object.key()?;
    if target.object.kind != ObjectKind::File || target.expected_version_number == 0
        || !valid_hash(&target.expected_content_hash) {
        return Err(invalid("Invalid File upload target"));
    }
    Ok(target)
}

fn read_bounded(source: impl Read) -> AgentResult<Vec<u8>> {
    let mut bytes = Vec::new();
    source.take(MAX_BODY + 1).read_to_end(&mut bytes)
        .map_err(|_| invalid("Cannot read local File content"))?;
    if bytes.len() as u64 > MAX_BODY { return Err(invalid("Local File content exceeds 100 MiB")); }
    Ok(bytes)
}

pub(super) fn read_file(path: &str) -> AgentResult<Vec<u8>> {
    let source: Box<dyn Read> = if path == "-" {
        Box::new(std::io::stdin())
    } else {
        Box::new(std::fs::File::open(path).map_err(|_| invalid("Cannot read local File content"))?)
    };
    read_bounded(source)
}


pub(super) trait UploadTransport {
    fn call(&self, method: &str, params: Value, request_id: &str) -> AgentResult<Value>;
}
pub(super) struct LiveTransport<'a> {
    pub client: &'a BridgeClient,
    pub grant_id: &'a str,
    pub binding: &'a WorkspaceBinding,
}
impl UploadTransport for LiveTransport<'_> {
    fn call(&self, method: &str, params: Value, request_id: &str) -> AgentResult<Value> {
        self.client.call(self.grant_id, self.binding, method, params, request_id)
    }
}

fn phase_id(original: &str, phase: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(original.as_bytes());
    hash.update([0]);
    hash.update(phase.as_bytes());
    format!("up-{:x}", hash.finalize())
}
fn mutation(request_id: &str, input: Value) -> Value { json!({"requestId":request_id,"input":input}) }
fn update(target: &FileUploadTargetInput, stage: &str, request_id: &str) -> Value {
    mutation(request_id, json!({
        "object":target.object.clone(),"expectedVersionNumber":target.expected_version_number,
        "expectedContentHash":target.expected_content_hash.clone(),"stagedContentId":stage,
    }))
}

pub(super) fn upload<T: UploadTransport>(transport: &T, target: FileUploadTargetInput, bytes: &[u8], request_id: &str) -> AgentResult<Value> {
    upload_target(transport, serde_json::to_value(target).expect("target"), bytes, request_id)
}
pub(super) fn upload_create<T: UploadTransport>(transport: &T, target: Value, bytes: &[u8], request_id: &str) -> AgentResult<Value> {
    upload_target(transport, json!({"createTarget":target}), bytes, request_id)
}
fn upload_target<T: UploadTransport>(transport: &T, target: Value, bytes: &[u8], request_id: &str) -> AgentResult<Value> {
    let create = target.get("createTarget");
    let final_method = if create.is_some() { "file.create" } else { "file.update" };
    let final_params = |stage: &str| if let Some(create) = create {
        mutation(request_id, json!({"projectId":create["projectId"],"safeName":create["safeName"],"stagedContentId":stage}))
    } else {
        let target: FileUploadTargetInput = serde_json::from_value(target.clone()).expect("validated target");
        update(&target, stage, request_id)
    };
    if request_id.is_empty() || request_id.len() > 128 || bytes.len() as u64 > MAX_BODY {
        return Err(invalid("Invalid File upload request ID or length"));
    }
    crate::agent::bridge::registry::validate(final_method, &final_params(&"0".repeat(32)))?;
    let content_hash = format!("sha256:{:x}", Sha256::digest(bytes));
    let begin_id = phase_id(request_id, "begin");
    let mut begin = target.clone();
    begin["length"] = json!(bytes.len());
    begin["contentHash"] = json!(content_hash);
    crate::agent::bridge::registry::validate("file.content.begin", &mutation(&begin_id, begin.clone()))?;
    let ticket = transport.call("file.content.begin", mutation(&begin_id, begin), &begin_id)?;
    let stage = ticket.get("stagedContentId").and_then(Value::as_str).ok_or_else(incompatible)?.to_owned();
    if ticket.get("length").and_then(Value::as_u64) != Some(bytes.len() as u64)
        || ticket.get("contentHash").and_then(Value::as_str) != Some(content_hash.as_str()) {
        return Err(incompatible());
    }
    let status = match transport.call("file.content.status", json!({"stagedContentId":stage}), &phase_id(request_id, "status")) {
        Ok(status) => status,
        Err(error) if error.code == ErrorCode::StagedContentExpired => {
            // The native receipt may outlive an expired stage. The same final
            // identity recovers a committed result, or reports the real expiry.
            return transport.call(final_method, final_params(&stage), request_id);
        }
        Err(error) => return Err(error),
    };
    if status.get("ticket").and_then(|ticket| ticket.get("stagedContentId")).and_then(Value::as_str) != Some(stage.as_str()) {
        return Err(incompatible());
    }
    let received = status.get("receivedLength").and_then(Value::as_u64).ok_or_else(incompatible)?;
    let ready = status.get("ready").and_then(Value::as_bool).ok_or_else(incompatible)?;
    let consumed = status.get("consumed").and_then(Value::as_bool).ok_or_else(incompatible)?;
    if received > bytes.len() as u64 { return Err(incompatible()); }
    if !ready && !consumed {
        if received != bytes.len() as u64 && received % CHUNK as u64 != 0 {
            return Err(incompatible());
        }
        for (index, chunk) in bytes[(received as usize)..].chunks(CHUNK).enumerate() {
            let offset = received + (index * CHUNK) as u64;
            let chunk_id = phase_id(request_id, &format!("chunk:{offset}"));
            transport.call("file.content.chunk", mutation(&chunk_id, json!({
                "stagedContentId":stage,"offset":offset,"dataBase64":STANDARD.encode(chunk),
            })), &chunk_id)?;
        }
        let finish_id = phase_id(request_id, "complete");
        transport.call("file.content.complete", mutation(&finish_id, json!({"stagedContentId":stage})), &finish_id)?;
    }
    transport.call(final_method, final_params(&stage), request_id)
}

pub(super) fn save_download(mut data: Value, path: &str) -> AgentResult<Value> {
    let encoded = data.get("base64").and_then(Value::as_str).ok_or_else(incompatible)?;
    if encoded.len() as u64 > (MAX_BODY + 2) / 3 * 4 { return Err(incompatible()); }
    let bytes = STANDARD.decode(encoded).map_err(|_| incompatible())?;
    if bytes.len() as u64 > MAX_BODY || data["byteLength"].as_u64() != Some(bytes.len() as u64)
        || data["contentHash"].as_str() != Some(format!("sha256:{:x}", Sha256::digest(&bytes)).as_str()) {
        return Err(incompatible());
    }
    // Publish complete, durable bytes in one same-directory operation. The
    // temporary file removes itself on write, sync or no-clobber failure.
    let target = std::path::Path::new(path);
    let directory = target.parent().filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let mut output = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot prepare download output"))?;
    std::io::Write::write_all(&mut output, &bytes)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot write download output"))?;
    output.as_file().sync_all()
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot sync download output"))?;
    output.persist_noclobber(target)
        .map_err(|_| AgentError::new(ErrorCode::IoFailed, "Cannot create download output; path must be new"))?;
    data.as_object_mut().ok_or_else(incompatible)?.remove("base64");
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[test]
    fn download_validates_before_publishing_and_never_overwrites_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("download.docx");
        let response = json!({"base64":"YWJj","byteLength":3,
            "contentHash":"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "versionNumber":1});
        let mut corrupted = response.clone();
        corrupted["contentHash"] = json!(format!("sha256:{}", "0".repeat(64)));
        assert!(save_download(corrupted, output.to_str().unwrap()).is_err());
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        std::fs::write(&output, b"existing bytes").unwrap();
        assert!(save_download(response.clone(), output.to_str().unwrap()).is_err());
        assert_eq!(std::fs::read(&output).unwrap(), b"existing bytes");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        let fresh = directory.path().join("new.docx");
        let receipt = save_download(response, fresh.to_str().unwrap()).unwrap();
        assert_eq!(std::fs::read(fresh).unwrap(), b"abc");
        assert!(receipt.get("base64").is_none());
        assert_eq!(receipt["versionNumber"], 1);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }
    struct Mock { calls: Mutex<Vec<(String, Value, String)>>, expired: bool, received: u64 }
    impl UploadTransport for Mock {
        fn call(&self, method: &str, params: Value, request_id: &str) -> AgentResult<Value> {
            self.calls.lock().unwrap().push((method.into(), params.clone(), request_id.into()));
            match method {
                "file.content.begin" => Ok(json!({"stagedContentId":"a".repeat(32),"length":CHUNK+3,"contentHash":params["input"]["contentHash"]})),
                "file.content.status" if self.expired => Err(AgentError::new(ErrorCode::StagedContentExpired, "expired")),
                "file.content.status" => Ok(json!({"ticket":{"stagedContentId":"a".repeat(32)},"receivedLength":self.received,"ready":false,"consumed":false})),
                "file.content.chunk" | "file.content.complete" => Ok(json!({})),
                "file.update" | "file.create" => Ok(json!({"result":{"versionNumber":2}})),
                _ => panic!("unexpected method"),
            }
        }
    }
    fn target() -> FileUploadTargetInput {
        decode_target(json!({"object":{"workspaceId":"workspace","scope":{"kind":"project","projectId":1},"kind":"file","id":"1"},"expectedVersionNumber":1,"expectedContentHash":format!("sha256:{}", "0".repeat(64))})).unwrap()
    }
    #[test]
    fn binary_create_uses_explicit_target_and_staged_create_contract() {
        let mock = Mock { calls: Mutex::new(vec![]), expired: false, received: 0 };
        upload_create(&mock, json!({"workspaceId":"workspace","projectId":1,"safeName":"report.docx"}),
            &vec![0;CHUNK+3], "create-stable").unwrap();
        let calls = mock.calls.lock().unwrap();
        assert_eq!(calls[0].1["input"]["createTarget"]["safeName"],"report.docx");
        assert!(calls[0].1["input"].get("object").is_none());
        assert_eq!(calls.last().unwrap().0,"file.create");
        assert_eq!(calls.last().unwrap().1["input"]["safeName"],"report.docx");
        assert_eq!(calls.last().unwrap().1["input"]["stagedContentId"],"a".repeat(32));
    }
    #[test]
    fn upload_sends_bytes_and_stable_phase_ids_without_local_paths() {
        let mock = Mock { calls: Mutex::new(vec![]), expired: false, received: 0 };
        let bytes = vec![b'x'; CHUNK + 3];
        assert_eq!(upload(&mock, target(), &bytes, "stable-upload").unwrap()["result"]["versionNumber"], 2);
        let calls = mock.calls.lock().unwrap();
        assert_eq!(calls.iter().map(|call| call.0.as_str()).collect::<Vec<_>>(), ["file.content.begin","file.content.status","file.content.chunk","file.content.chunk","file.content.complete","file.update"]);
        for (_, params, id) in calls.iter() {
            assert!(!params.to_string().contains("/tmp"));
            assert!(id.len() <= 128);
        }
        assert_eq!(calls.last().unwrap().2, "stable-upload");
        assert_eq!(calls[0].1["input"]["contentHash"], format!("sha256:{:x}", Sha256::digest(&bytes)));
        assert_eq!(calls[2].1["input"]["offset"], 0);
        assert_eq!(calls[3].1["input"]["offset"], CHUNK as u64);
        assert_eq!(STANDARD.decode(calls[3].1["input"]["dataBase64"].as_str().unwrap()).unwrap(), b"xxx");
        assert_ne!(calls[2].2, calls[3].2);
    }
    #[test]
    fn expired_status_only_attempts_final_receipt_replay() {
        let mock = Mock { calls: Mutex::new(vec![]), expired: true, received: 0 };
        upload(&mock, target(), &vec![0; CHUNK+3], "same-id").unwrap();
        assert_eq!(mock.calls.lock().unwrap().iter().map(|call| call.0.as_str()).collect::<Vec<_>>(), ["file.content.begin","file.content.status","file.update"]);
    }
    #[test]
    fn body_reader_preserves_binary_bytes() {
        assert_eq!(read_bounded(std::io::Cursor::new(vec![1,2,3])).unwrap(), vec![1,2,3]);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), [0, 255, 10, 36, 96]).unwrap();
        assert_eq!(read_file(file.path().to_str().unwrap()).unwrap(), vec![0, 255, 10, 36, 96]);
    }
    #[test]
    fn completed_short_last_chunk_resumes_at_seal() {
        let mock = Mock { calls: Mutex::new(vec![]), expired: false, received: (CHUNK + 3) as u64 };
        upload(&mock, target(), &vec![b'x'; CHUNK + 3], "resume-id").unwrap();
        assert_eq!(mock.calls.lock().unwrap().iter().map(|call| call.0.as_str()).collect::<Vec<_>>(),
            ["file.content.begin", "file.content.status", "file.content.complete", "file.update"]);
    }
}
