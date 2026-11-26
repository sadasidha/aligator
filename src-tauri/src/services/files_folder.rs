use crate::{
    err::app_err::AppErr,
    models::files_folder::{DirDef, FileDef, FileFolder, Inaccessible},
};
use std::path::Path;

impl FileFolder {
    pub fn load(file_path: impl Into<String>) -> Result<Vec<Self>, AppErr> {
        let file_path = file_path.into();
        let entries = std::fs::read_dir(&file_path).map_err(|error| {
            AppErr::new(format!("Failed to read directory {file_path}: {error}"))
        })?;

        entries
            .map(|entry| {
                let entry = entry.map_err(|error| {
                    AppErr::new(format!("Failed to read an entry in {file_path}: {error}"))
                })?;
                Ok(from_entry(&entry))
            })
            .collect()
    }

    /// Recursively finds entries under `root` whose name contains `query` (case-insensitive).
    /// Symlinked folders are reported but not descended into. Stops after `limit` matches.
    pub fn search(
        root: impl Into<String>,
        query: &str,
        limit: usize,
    ) -> Result<(Vec<Self>, bool), AppErr> {
        let root = root.into();
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok((Vec::new(), false));
        }
        std::fs::read_dir(&root)
            .map_err(|error| AppErr::new(format!("Failed to read directory {root}: {error}")))?;

        let mut results = Vec::new();
        let mut pending = vec![std::path::PathBuf::from(&root)];
        while let Some(dir) = pending.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) => {
                    tracing::warn!("Skipping {} during search: {error}", dir.display());
                    continue;
                }
            };
            for entry in entries.flatten() {
                let is_real_dir = entry.file_type().is_ok_and(|file_type| file_type.is_dir());
                if entry.file_name().to_string_lossy().to_lowercase().contains(&needle) {
                    if results.len() >= limit {
                        return Ok((results, true));
                    }
                    results.push(from_entry(&entry));
                }
                if is_real_dir {
                    pending.push(entry.path());
                }
            }
        }
        Ok((results, false))
    }
}

fn from_entry(entry: &std::fs::DirEntry) -> FileFolder {
    let path = entry.path();
    let file_type = match entry.file_type() {
        Ok(file_type) => file_type,
        Err(error) => {
            tracing::warn!("Failed to read file type for {}: {error}", path.display());
            return inaccessible(&path, false);
        }
    };
    let is_shortcut = file_type.is_symlink();
    let metadata = match entry.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            tracing::warn!("Failed to read metadata for {}: {error}", path.display());
            return inaccessible(&path, is_shortcut);
        }
    };

    let modified_at = modified_millis(&metadata);

    if metadata.is_dir() {
        match count_children(&path) {
            Ok(children_count) => FileFolder::DirDef(DirDef {
                full_path: path.to_string_lossy().into_owned(),
                is_shortcut,
                children_count,
                modified_at,
            }),
            Err(error) => {
                tracing::warn!("Failed to count children in {}: {error}", path.display());
                inaccessible(&path, is_shortcut)
            }
        }
    } else {
        FileFolder::FileDef(FileDef {
            file_name: entry.file_name().to_string_lossy().into_owned(),
            extension: path
                .extension()
                .map(|extension| extension.to_string_lossy().into_owned())
                .unwrap_or_default(),
            full_path: path.to_string_lossy().into_owned(),
            is_shortcut,
            modified_at,
        })
    }
}

fn inaccessible(path: &Path, is_shortcut: bool) -> FileFolder {
    FileFolder::Inaccessible(Inaccessible {
        full_path: path.to_string_lossy().into_owned(),
        is_shortcut,
    })
}

pub(crate) fn modified_millis(metadata: &std::fs::Metadata) -> Option<u64> {
    let duration = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    u64::try_from(duration.as_millis()).ok()
}

fn count_children(path: &Path) -> Result<i32, String> {
    std::fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .try_fold(0_i32, |count, entry| {
            entry.map_err(|error| error.to_string())?;
            count
                .checked_add(1)
                .ok_or_else(|| "too many entries to count".to_string())
        })
}
