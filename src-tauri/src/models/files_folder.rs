use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirDef {
    pub(crate) full_path: String,
    pub(crate) is_shortcut: bool,
    pub(crate) children_count: i32,
    /// Milliseconds since the Unix epoch; `None` when the platform can't report it.
    pub(crate) modified_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDef {
    pub(crate) file_name: String,
    pub(crate) extension: String,
    pub(crate) full_path: String,
    pub(crate) is_shortcut: bool,
    /// Milliseconds since the Unix epoch; `None` when the platform can't report it.
    pub(crate) modified_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inaccessible {
    pub(crate) full_path: String,
    pub(crate) is_shortcut: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileFolder {
    #[serde(rename = "dir")]
    DirDef(DirDef),
    #[serde(rename = "file")]
    FileDef(FileDef),
    Inaccessible(Inaccessible),
}
