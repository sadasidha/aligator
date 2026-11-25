use std::{fs::File, io::Read};

use crate::err::app_err::AppErr;

// More than enough to fill the preview panel without loading large files.
const PREVIEW_BYTES: u64 = 16 * 1024;

pub(crate) fn read_text_preview(path: &str) -> Result<String, AppErr> {
    let mut bytes = Vec::new();
    File::open(path)?.take(PREVIEW_BYTES).read_to_end(&mut bytes)?;

    if bytes.contains(&0) {
        return Err(AppErr::new("This file is not text"));
    }

    match std::str::from_utf8(&bytes) {
        Ok(text) => Ok(text.to_owned()),
        // The read limit can split a multi-byte character; drop the partial tail.
        Err(error) if error.error_len().is_none() => {
            Ok(String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned())
        }
        Err(_) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
    }
}
