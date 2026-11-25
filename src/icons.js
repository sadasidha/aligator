const EXTENSION_TYPES = {
  image: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif", "raw"],
  video: ["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v", "mpg", "mpeg", "3gp"],
  audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff", "opus"],
  pdf: ["pdf"],
  word: ["doc", "docx", "odt", "rtf", "pages"],
  excel: ["xls", "xlsx", "xlsm", "ods", "csv", "tsv", "numbers"],
  powerpoint: ["ppt", "pptx", "odp", "key"],
  text: ["txt", "md", "markdown", "log", "ini", "cfg", "conf"],
  code: [
    "js", "mjs", "cjs", "ts", "jsx", "tsx", "rs", "py", "rb", "go", "java", "kt", "swift",
    "c", "h", "cpp", "hpp", "cs", "php", "sh", "zsh", "bash", "html", "css", "scss",
    "json", "toml", "yaml", "yml", "xml", "sql", "lua", "vue",
  ],
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "iso", "pkg"],
};

const TYPE_BY_EXTENSION = new Map(
  Object.entries(EXTENSION_TYPES).flatMap(([type, extensions]) =>
    extensions.map((extension) => [extension, type]),
  ),
);

const DOCUMENT_LABELS = {
  pdf: { text: "PDF", color: "#e5484d" },
  word: { text: "DOC", color: "#2f6fdb" },
  excel: { text: "XLS", color: "#1f9d55" },
  powerpoint: { text: "PPT", color: "#e8772e" },
  text: { text: "TXT", color: "#7c8591" },
  code: { text: "&lt;/&gt;", color: "#8e4ec6" },
  archive: { text: "ZIP", color: "#b08900" },
};

const PAGE_PATH = "M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z";
const PAGE_FOLD = "M14 2v5h5";

const ICONS = {
  folder: `
    <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" fill="#f5b83d"/>
    <path d="M2 9h20v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" fill="#ffcf5c"/>`,
  image: `
    <rect x="2" y="4" width="20" height="16" rx="2" fill="#3e9bdc"/>
    <circle cx="8" cy="9" r="2" fill="#fff6c2"/>
    <path d="M2 17l6-6 4 4 3-3 7 7v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" fill="#2c7a3f"/>`,
  video: `
    <rect x="2" y="4" width="20" height="16" rx="2" fill="#6e56cf"/>
    <path d="M2 7h20M2 17h20" stroke="#4a3a99" stroke-width="2"/>
    <path d="M10 9.5v5l4.5-2.5z" fill="#ffffff"/>`,
  audio: `
    <path d="${PAGE_PATH}" fill="#e93d82"/>
    <path d="${PAGE_FOLD}" fill="#f78fb8"/>
    <path d="M10 17.5a1.75 1.75 0 1 1-1-1.6V10l6-1.5v7a1.75 1.75 0 1 1-1-1.6V10.2l-4 1z" fill="#ffffff"/>`,
  unknown: `
    <path d="${PAGE_PATH}" fill="#d4d8dd" stroke="#9aa3ad" stroke-width="1"/>
    <path d="${PAGE_FOLD}" fill="#f2f3f5" stroke="#9aa3ad" stroke-width="1"/>
    <text x="11.5" y="18" text-anchor="middle" font-size="9" font-weight="700" fill="#6b7480"
      font-family="Helvetica, Arial, sans-serif">?</text>`,
  inaccessible: `
    <rect x="5" y="10" width="14" height="11" rx="2" fill="#8b95a1"/>
    <path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="#8b95a1" stroke-width="2"/>
    <circle cx="12" cy="15.5" r="1.5" fill="#ffffff"/>`,
};

const SHORTCUT_BADGE = `
  <rect x="12" y="12" width="12" height="12" rx="2" fill="#ffffff" stroke="#5b6570" stroke-width="1"/>
  <path d="M15 21v-2.5a3 3 0 0 1 3-3h2.5M18.5 13.5l2.5 2-2.5 2" fill="none" stroke="#2f6fdb"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;

function documentIcon({ text, color }) {
  return `
    <path d="${PAGE_PATH}" fill="#f7f8fa" stroke="#aab2bc" stroke-width="1"/>
    <path d="${PAGE_FOLD}" fill="#e3e6ea" stroke="#aab2bc" stroke-width="1"/>
    <rect x="2" y="12" width="15" height="7" rx="1.5" fill="${color}"/>
    <text x="9.5" y="17.6" text-anchor="middle" font-size="5.6" font-weight="700" fill="#ffffff"
      font-family="Helvetica, Arial, sans-serif">${text}</text>`;
}

export function iconType(entry) {
  if (entry.kind === "dir") return "folder";
  if (entry.kind === "inaccessible") return "inaccessible";
  return TYPE_BY_EXTENSION.get(entry.extension.toLowerCase()) ?? "unknown";
}

export function createIcon(type, isShortcut, size = 18) {
  const body = ICONS[type] ?? documentIcon(DOCUMENT_LABELS[type]);
  const wrapper = document.createElement("span");
  wrapper.className = "entry-icon";
  wrapper.innerHTML = `
    <svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
      ${body}
      ${isShortcut ? SHORTCUT_BADGE : ""}
    </svg>`;
  return wrapper;
}
