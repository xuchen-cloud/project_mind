//! CLI byte input: UTF-8 (optionally BOM-prefixed), never lossy decoding.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};
use serde_json::Value;

pub(super) fn decode_utf8(bytes: &[u8]) -> AgentResult<&str> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return Err(AgentError::new(ErrorCode::InvalidArgument,
            "Input is UTF-16; save it as UTF-8 (PowerShell: [IO.File]::WriteAllText with [Text.UTF8Encoding]::new($false))"));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| {
        AgentError::new(
            ErrorCode::InvalidArgument,
            "Input is not valid UTF-8; save it as UTF-8 before passing it to mind",
        )
    })?;
    // BOM-less UTF-16 ASCII contains NULs. Do not guess an endianness or repair it.
    if text.contains('\0') {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Input contains NUL bytes (possibly UTF-16 without a BOM); save it as UTF-8",
        ));
    }
    Ok(text)
}

pub(super) fn parse_json(bytes: &[u8]) -> AgentResult<Value> {
    let text = decode_utf8(bytes)?;
    serde_json::from_str(text).map_err(|error| {
        AgentError::new(
            ErrorCode::InvalidArgument,
            format!(
                "Input must contain valid JSON (line {}, column {})",
                error.line(),
                error.column()
            ),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_json_and_bom_preserve_unicode_and_body_whitespace() {
        for prefix in [b"".as_slice(), &[0xef, 0xbb, 0xbf]] {
            let bytes = [prefix, "{\"正文\":\"火车\"}".as_bytes()].concat();
            assert_eq!(parse_json(&bytes).unwrap()["正文"], "火车");
            let body = [prefix, "  第一行\n\n".as_bytes()].concat();
            assert_eq!(decode_utf8(&body).unwrap(), "  第一行\n\n");
        }
    }
    #[test]
    fn unsupported_encodings_and_invalid_json_are_actionable_without_input_echo() {
        for bytes in [&[0xff, 0xfe, b'{', 0][..], &[0xfe, 0xff, 0, b'{'][..]] {
            assert!(parse_json(bytes).unwrap_err().message.contains("UTF-16"));
        }
        assert!(parse_json(b"{\0}\0").unwrap_err().message.contains("NUL"));
        assert!(decode_utf8(&[0xff]).unwrap_err().message.contains("UTF-8"));
        let error = parse_json(b"secret-invalid-input").unwrap_err();
        assert!(error.message.contains("line 1"));
        assert!(!error.message.contains("secret-invalid-input"));
    }
}
