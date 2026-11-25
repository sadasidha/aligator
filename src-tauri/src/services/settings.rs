use crate::{err::app_err::AppErr, models::settings::Settings};
use tracing::error;

static ALIGATOR_SETTINGS_FILE: &str = "~/.aligtor/settings.json";

impl Settings {
    pub fn load() -> Result<Self, AppErr> {
        match Self::load_from_file(ALIGATOR_SETTINGS_FILE) {
            Ok(settings) => Ok(settings),
            Err(e) => {
                error!("Failed to load settings from file: {e}");
                Ok(Settings {
                    current_path: Self::get_home()?,
                })
            }
        }
    }

    fn get_home() -> Result<String, AppErr> {
        std::env::home_dir()
            .filter(|path| path.is_absolute())
            .ok_or_else(|| AppErr::new("could not determine an absolute home directory"))?
            .into_os_string()
            .into_string()
            .map_err(|_| AppErr::new("home directory path is not valid UTF-8"))
    }

    pub fn load_from_file(file_path: &str) -> Result<Self, AppErr> {
        let expanded_path = shellexpand::tilde(file_path).to_string();
        let file_text = std::fs::read_to_string(&expanded_path)?;
        serde_json::from_str(&file_text).map_err(|e| AppErr::new(e.to_string()))
    }

    pub fn save(&self) -> Result<(), AppErr> {
        self.save_to_file(ALIGATOR_SETTINGS_FILE)
    }

    pub fn save_to_file(&self, file_path: &str) -> Result<(), AppErr> {
        let path = std::path::PathBuf::from(shellexpand::tilde(file_path).to_string());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file_text = serde_json::to_string_pretty(self).map_err(|e| AppErr::new(e.to_string()))?;
        // Write to a temp file first so a crash never leaves a half-written settings file.
        let temp_path = path.with_extension("json.tmp");
        std::fs::write(&temp_path, file_text)?;
        std::fs::rename(&temp_path, &path)?;
        Ok(())
    }
}