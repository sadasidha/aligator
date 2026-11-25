pub struct AppErr {
    pub msg: String,
}

impl AppErr {
    pub fn new(msg: impl Into<String>) -> AppErr {
        Self {
            msg: msg.into()
        }
    }
}

impl From<std::io::Error> for AppErr {
    fn from(error: std::io::Error) -> Self {
        let message = format!("[i/o Error]: {}", error);
        AppErr::new(message)
    }
}

impl std::fmt::Display for AppErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.msg)
    }
}
