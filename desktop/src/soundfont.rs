//! A user-selected MIDI bank, private to this device and never in Corestore.
use std::{fs, io, path::PathBuf};
use crate::worker::DATA_DIR;

mod storage;

const MAX_BYTES: u64 = 256 * 1024 * 1024;

pub fn path() -> Option<PathBuf> {
    let path = DATA_DIR.join("soundfont.sf2");
    path.is_file().then_some(path)
}

pub fn clear() -> Result<(), String> {
    match fs::remove_file(DATA_DIR.join("soundfont.sf2")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Copies the file at `source` in as the bank, on its own thread. A file that
/// is too big, unreadable, truncated or not a SoundFont 2 leaves the current
/// bank in place.
pub async fn import(source: PathBuf) -> Result<(), String> {
    let (tx, rx) = futures_channel::oneshot::channel();
    std::thread::spawn(move || {
        let temporary = DATA_DIR.join(".soundfont-import.tmp");
        let result = (|| {
            fs::create_dir_all(&*DATA_DIR)?;
            let file = fs::File::open(&source)?;
            if file.metadata()?.len() > MAX_BYTES {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "SoundFont exceeds the 256 MiB import limit"));
            }
            storage::stage(file, &temporary, MAX_BYTES)?;
            storage::commit(&temporary, &DATA_DIR.join("soundfont.sf2"))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        let _ = tx.send(result.map_err(|e| e.to_string()));
    });
    rx.await.map_err(|_| "SoundFont import stopped".to_string())?
}
