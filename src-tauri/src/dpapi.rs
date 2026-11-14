#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(windows)]
use std::io::{Read, Write};

#[cfg(windows)]
pub fn encrypt_base64(plain_text: &str) -> Result<String, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let bytes = plain_text.as_bytes();
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &in_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("CryptProtectData hatası: {e}"))?;

        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let encoded = BASE64.encode(slice);
        let _ = LocalFree(HLOCAL(out_blob.pbData as *mut core::ffi::c_void));
        Ok(encoded)
    }
}

#[cfg(windows)]
pub fn decrypt_base64(cipher_base64: &str) -> Result<String, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let raw = BASE64
        .decode(cipher_base64.trim())
        .map_err(|e| format!("Base64 çözümleme hatası: {e}"))?;

    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: raw.len() as u32,
        pbData: raw.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(
            &in_blob,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("CryptUnprotectData hatası: {e}"))?;

        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let text = String::from_utf8(slice.to_vec())
            .map_err(|e| format!("UTF-8 çözümleme hatası: {e}"))?;
        let _ = LocalFree(HLOCAL(out_blob.pbData as *mut core::ffi::c_void));
        Ok(text)
    }
}

#[cfg(not(windows))]
pub fn encrypt_base64(_plain_text: &str) -> Result<String, String> {
    Err("Windows DPAPI bu platformda desteklenmiyor.".into())
}

#[cfg(not(windows))]
pub fn decrypt_base64(_cipher_base64: &str) -> Result<String, String> {
    Err("Windows DPAPI bu platformda desteklenmiyor.".into())
}

pub fn handle_cli_dpapi() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let is_enc = args.iter().any(|a| a == "--dpapi-encrypt");
    let is_dec = args.iter().any(|a| a == "--dpapi-decrypt");

    if !is_enc && !is_dec {
        return None;
    }

    #[cfg(windows)]
    {
        let mut input = String::new();
        if let Err(e) = std::io::stdin().read_to_string(&mut input) {
            eprintln!("stdin okuma hatası: {e}");
            return Some(1);
        }

        let res = if is_enc {
            encrypt_base64(&input)
        } else {
            decrypt_base64(&input)
        };

        match res {
            Ok(out) => {
                let _ = std::io::stdout().write_all(out.as_bytes());
                let _ = std::io::stdout().flush();
                Some(0)
            }
            Err(err) => {
                eprintln!("{err}");
                Some(1)
            }
        }
    }

    #[cfg(not(windows))]
    {
        eprintln!("Windows DPAPI bu platformda desteklenmiyor.");
        Some(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn dpapi_roundtrip() {
        let secret = "mesai-secret-token-12345";
        let encrypted = encrypt_base64(secret).expect("encrypt");
        assert_ne!(encrypted, secret);
        let decrypted = decrypt_base64(&encrypted).expect("decrypt");
        assert_eq!(decrypted, secret);
    }
}
