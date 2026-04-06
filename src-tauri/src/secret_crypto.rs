use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context, Result};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;

use crate::device_identity;

const DERIVATION_CONTEXT: &str = "project-mind-alpha::ai-secret::v1";
const SALT_BYTES: usize = 16;
const NONCE_BYTES: usize = 12;
const KEY_BYTES: usize = 32;

pub struct EncryptedSecret {
    pub ciphertext_b64: String,
    pub nonce_b64: String,
    pub salt_b64: String,
    pub last4: String,
}

pub fn encrypt_secret(secret: &str) -> Result<EncryptedSecret> {
    if secret.trim().is_empty() {
        return Err(anyhow!("API key cannot be empty"));
    }

    let mut salt = [0_u8; SALT_BYTES];
    let mut nonce = [0_u8; NONCE_BYTES];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);

    let key = derive_key(&salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("failed to initialize cipher"))?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), secret.as_bytes())
        .map_err(|_| anyhow!("failed to encrypt API key"))?;

    Ok(EncryptedSecret {
        ciphertext_b64: STANDARD.encode(ciphertext),
        nonce_b64: STANDARD.encode(nonce),
        salt_b64: STANDARD.encode(salt),
        last4: secret
            .chars()
            .rev()
            .take(4)
            .collect::<String>()
            .chars()
            .rev()
            .collect(),
    })
}

pub fn decrypt_secret(ciphertext_b64: &str, nonce_b64: &str, salt_b64: &str) -> Result<String> {
    let ciphertext = STANDARD
        .decode(ciphertext_b64)
        .context("invalid encrypted API key payload")?;
    let nonce = STANDARD
        .decode(nonce_b64)
        .context("invalid encrypted API key nonce")?;
    let salt = STANDARD
        .decode(salt_b64)
        .context("invalid encrypted API key salt")?;

    if nonce.len() != NONCE_BYTES {
        return Err(anyhow!("encrypted API key nonce had an unexpected length"));
    }

    let key = derive_key(&salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("failed to initialize cipher"))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("stored API key could not be decrypted on this device"))?;

    String::from_utf8(plaintext).context("decrypted API key was not valid UTF-8")
}

fn derive_key(salt: &[u8]) -> Result<[u8; KEY_BYTES]> {
    let device_material = device_identity::current_device_material()?;
    let password = format!("{DERIVATION_CONTEXT}::{device_material}");

    let mut key = [0_u8; KEY_BYTES];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| anyhow!("failed to derive API key encryption key: {error}"))?;
    Ok(key)
}
