//! Connection secrets live only in the current user's OS credential store.
use crate::agent::errors::{AgentError, AgentResult, ErrorCode};

const SERVICE: &str = "com.xuchen.projectmind.alpha.connections";

fn locked() -> AgentError {
    AgentError::new(
        ErrorCode::SecretsLocked,
        "The operating system credential store is unavailable",
    )
}

fn entry(grant_id: &str) -> AgentResult<keyring::Entry> {
    if grant_id.len() != 32 || !grant_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AgentError::new(
            ErrorCode::InvalidArgument,
            "Invalid connection ID",
        ));
    }
    keyring::Entry::new(SERVICE, grant_id).map_err(|_| locked())
}

pub fn save(grant_id: &str, token: &str) -> AgentResult<()> {
    entry(grant_id)?.set_password(token).map_err(|_| locked())
}

pub fn load(grant_id: &str) -> AgentResult<String> {
    entry(grant_id)?.get_password().map_err(|error| match error {
        keyring::Error::NoEntry => AgentError::new(ErrorCode::ScopeDenied, "Connection credential not found; create a connection in ProjectMind settings"),
        _ => locked(),
    })
}

pub fn delete(grant_id: &str) -> AgentResult<()> {
    match entry(grant_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(locked()),
    }
}
