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
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(file_type) => file_type,
                    Err(error) => {
                        tracing::warn!("Failed to read file type for {}: {error}", path.display());
                        return Ok(inaccessible(&path, false));
                    }
                };
                let is_shortcut = file_type.is_symlink();
                let metadata = match entry.metadata() {
                    Ok(metadata) => metadata,
                    Err(error) => {
                        tracing::warn!("Failed to read metadata for {}: {error}", path.display());
                        return Ok(inaccessible(&path, is_shortcut));
                    }
                };

                let modified_at = modified_millis(&metadata);

                if metadata.is_dir() {
                    match count_children(&path) {
                        Ok(children_count) => Ok(FileFolder::DirDef(DirDef {
                            full_path: path.to_string_lossy().into_owned(),
                            is_shortcut,
                            children_count,
                            modified_at,
                        })),
                        Err(error) => {
                            tracing::warn!("Failed to count children in {}: {error}", path.display());
                            Ok(inaccessible(&path, is_shortcut))
                        }
                    }
                } else {
                    Ok(FileFolder::FileDef(FileDef {
                        file_name: entry.file_name().to_string_lossy().into_owned(),
                        extension: path
                            .extension()
                            .map(|extension| extension.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        full_path: path.to_string_lossy().into_owned(),
                        is_shortcut,
                        modified_at,
                    }))
                }
            })
            .collect()
    }
}

fn inaccessible(path: &Path, is_shortcut: bool) -> FileFolder {
    FileFolder::Inaccessible(Inaccessible {
        full_path: path.to_string_lossy().into_owned(),
        is_shortcut,
    })
}

fn modified_millis(metadata: &std::fs::Metadata) -> Option<u64> {
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
