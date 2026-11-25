import { createIcon, iconType } from "./icons.js";

window.addEventListener("DOMContentLoaded", async () => {
  const addressInputEl = document.querySelector("#address-input");
  const statusBarEl = document.querySelector("#status-bar");
  const leftPanelEl = document.querySelector("#left-panel");
  const rightPanelEl = document.querySelector("#right-panel");
  const backButtonEl = document.querySelector("#back-button");
  const forwardButtonEl = document.querySelector("#forward-button");
  const upButtonEl = document.querySelector("#up-button");

  const history = [];
  let historyIndex = -1;

  function updateNavButtons() {
    backButtonEl.disabled = historyIndex <= 0;
    forwardButtonEl.disabled = historyIndex >= history.length - 1;
    upButtonEl.disabled = historyIndex < 0 || parentPath(history[historyIndex]) === null;
  }

  let addressEdited = false;
  addressInputEl.addEventListener("input", () => {
    addressEdited = true;
  }, { once: true });

  let currentPath;
  try {
    currentPath = await window.__TAURI__.core.invoke("load_current_path");
    if (!addressEdited) {
      addressInputEl.value = currentPath;
    }
  } catch (error) {
    console.error("Could not load the current path:", error);
    statusBarEl.textContent = "Could not load the current path";
    return;
  }

  // Ignores responses from superseded navigations when folders are opened in quick succession.
  let navigationId = 0;

  // Saves run one at a time so an older path can never overwrite a newer one.
  let savedPath = currentPath;
  let saveQueue = Promise.resolve();
  function rememberPath(path) {
    if (path === savedPath) return;
    savedPath = path;
    saveQueue = saveQueue
      .then(() => window.__TAURI__.core.invoke("save_current_path", { path }))
      .catch((error) => console.error("Could not save the current path:", error));
  }

  // `historyMove` is -1/+1 for Back/Forward; otherwise a successful load becomes a new history entry.
  async function navigateTo(path, { updateAddress = true, historyMove = 0 } = {}) {
    const requestId = ++navigationId;
    try {
      const entries = await window.__TAURI__.core.invoke("load_file_folder", { path });
      if (requestId !== navigationId) return;

      if (historyMove !== 0) {
        historyIndex += historyMove;
      } else if (history[historyIndex] !== path) {
        history.splice(historyIndex + 1, Infinity, path);
        historyIndex = history.length - 1;
      }
      updateNavButtons();
      rememberPath(path);

      if (updateAddress) {
        addressInputEl.value = path;
      }
      renderEntries(leftPanelEl, entries);
      leftPanelEl.scrollTop = 0;
      clearPreview();
      statusBarEl.textContent = `${entries.length} items`;
    } catch (error) {
      if (requestId !== navigationId) return;
      console.error("Could not load folder contents:", error);
      statusBarEl.textContent = `Could not open ${path}`;
    }
  }

  addressInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const path = normalizePath(addressInputEl.value);
      if (path) {
        navigateTo(path);
      }
    } else if (e.key === "Escape" && historyIndex >= 0) {
      addressInputEl.value = history[historyIndex];
    }
  });

  backButtonEl.addEventListener("click", () => {
    if (historyIndex > 0) {
      navigateTo(history[historyIndex - 1], { historyMove: -1 });
    }
  });

  forwardButtonEl.addEventListener("click", () => {
    if (historyIndex < history.length - 1) {
      navigateTo(history[historyIndex + 1], { historyMove: 1 });
    }
  });

  upButtonEl.addEventListener("click", () => {
    const parent = historyIndex >= 0 ? parentPath(history[historyIndex]) : null;
    if (parent !== null) {
      navigateTo(parent);
    }
  });

  // Ignores responses for folders that are no longer selected.
  let previewId = 0;
  // Releases the libVLC player behind the current preview, if any.
  let stopActiveVideo = null;

  function nextPreview() {
    stopActiveVideo?.();
    stopActiveVideo = null;
    return ++previewId;
  }

  function clearPreview() {
    nextPreview();
    rightPanelEl.replaceChildren();
  }

  const PREVIEW_TRANSFORMS = {
    rotate90: { label: "Rotate 90° clockwise", icon: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>' },
    flipVertical: { label: "Flip vertically", icon: '<path d="M4 12h16M8 8l4-4 4 4M8 16l4 4 4-4"/>' },
    flipHorizontal: { label: "Flip horizontally", icon: '<path d="M12 4v16M8 8l-4 4 4 4M16 8l4 4-4 4"/>' },
  };
  const SAVABLE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "tif", "tiff"];

  async function alertDialog(message) {
    const dialog = window.__TAURI__.dialog;
    return dialog ? dialog.message(message, { title: "Aligator", kind: "error" }) : window.alert(message);
  }

  function editedCopyPath(path) {
    const name = baseName(path);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot + 1) : "";
    const copyExtension = SAVABLE_EXTENSIONS.includes(extension.toLowerCase()) ? extension : "png";
    return `${path.slice(0, path.length - name.length)}${stem}-edited.${copyExtension}`;
  }

  function imageSrc(path) {
    const source = window.__TAURI__.core.convertFileSrc(path);
    return `${source}?v=${Date.now()}`;
  }

  function showImage(path) {
    const requestId = nextPreview();
    const name = baseName(path);
    const viewerEl = document.createElement("div");
    viewerEl.className = "image-viewer";

    const toolbarEl = document.createElement("div");
    toolbarEl.className = "image-toolbar";

    const frameEl = document.createElement("div");
    frameEl.className = "image-frame";
    const imageEl = document.createElement("img");
    imageEl.className = "image-view";
    imageEl.alt = name;
    imageEl.addEventListener("error", () => {
      if (requestId !== previewId) return;
      const messageEl = document.createElement("p");
      messageEl.className = "grid-message";
      messageEl.textContent = `Cannot preview ${name}`;
      rightPanelEl.replaceChildren(messageEl);
    });
    imageEl.src = imageSrc(path);
    frameEl.append(imageEl);

    // Edits are only previewed until the user saves them.
    let pending = [];
    const saveGroupEl = document.createElement("span");
    saveGroupEl.className = "image-save-group";
    saveGroupEl.hidden = true;

    function setPending(transforms) {
      pending = transforms;
      // Fold the edits into one `rotate() scale()` pair so every step animates between
      // same-shaped transforms; chains of differing length fall back to matrix
      // interpolation, which WebKit can get wrong.
      let angle = 0;
      let scaleX = 1;
      let scaleY = 1;
      for (const transform of pending) {
        const quarterTurn = (angle / 90) % 2 === 1;
        if (transform === "rotate90") {
          angle += 90;
        } else if ((transform === "flipHorizontal") !== quarterTurn) {
          // On a quarter turn, flipping the screen axis flips the image's other axis.
          scaleX = -scaleX;
        } else {
          scaleY = -scaleY;
        }
      }
      imageEl.style.transform = pending.length ? `rotate(${angle}deg) scale(${scaleX}, ${scaleY})` : "";
      imageEl.classList.toggle("quarter-turn", (angle / 90) % 2 === 1);
      saveGroupEl.hidden = pending.length === 0;
    }

    function setBusy(busy) {
      toolbarEl.querySelectorAll("button").forEach((el) => (el.disabled = busy));
    }

    async function save(destination) {
      setBusy(true);
      try {
        await window.__TAURI__.core.invoke("transform_image", { path, transforms: pending, destination });
        if (destination) {
          setPending([]);
          statusBarEl.textContent = `Saved as ${baseName(destination)}`;
        } else {
          saveGroupEl.hidden = true;
          statusBarEl.textContent = `Saved ${name}`;
          // Decode the saved file off-screen, then swap it in without animating the preview transform away.
          const savedSrc = imageSrc(path);
          const loaderEl = new Image();
          loaderEl.src = savedSrc;
          await loaderEl.decode().catch(() => {});
          imageEl.style.transition = "none";
          imageEl.src = savedSrc;
          setPending([]);
          void imageEl.offsetWidth;
          imageEl.style.transition = "";
        }
      } catch (error) {
        console.error("Could not save image:", error);
        setPending([]);
        statusBarEl.textContent = `Failed to save ${name}`;
        await alertDialog(`Failed to save ${name}.\n${error}`);
      } finally {
        setBusy(false);
      }
    }

    for (const [transform, { label, icon }] of Object.entries(PREVIEW_TRANSFORMS)) {
      const buttonEl = document.createElement("button");
      buttonEl.type = "button";
      buttonEl.className = "nav-button";
      buttonEl.title = label;
      buttonEl.setAttribute("aria-label", label);
      buttonEl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      buttonEl.addEventListener("click", () => setPending([...pending, transform]));
      toolbarEl.append(buttonEl);
    }

    const saveButtonEl = document.createElement("button");
    saveButtonEl.type = "button";
    saveButtonEl.className = "text-button";
    saveButtonEl.textContent = "Save";
    saveButtonEl.title = `Overwrite ${name}`;
    saveButtonEl.addEventListener("click", () => save(null));

    const saveAsButtonEl = document.createElement("button");
    saveAsButtonEl.type = "button";
    saveAsButtonEl.className = "text-button";
    saveAsButtonEl.textContent = "Save as…";
    saveAsButtonEl.title = "Save the edited image as a new file";
    saveAsButtonEl.addEventListener("click", async () => {
      const dialog = window.__TAURI__.dialog;
      if (!dialog) return;
      setBusy(true);
      let destination;
      try {
        destination = await dialog.save({
          defaultPath: editedCopyPath(path),
          filters: [{ name: "Images", extensions: SAVABLE_EXTENSIONS }],
        });
      } finally {
        setBusy(false);
      }
      if (destination) {
        await save(destination);
      }
    });

    saveGroupEl.append(saveButtonEl, saveAsButtonEl);
    toolbarEl.append(saveGroupEl);

    viewerEl.append(toolbarEl, frameEl, previewCaption(path));
    rightPanelEl.replaceChildren(viewerEl);
    rightPanelEl.scrollTop = 0;
  }

  function previewCaption(path) {
    const captionEl = document.createElement("div");
    captionEl.className = "preview-caption";
    captionEl.textContent = baseName(path);
    captionEl.title = path;
    return captionEl;
  }

  const TEXT_PREVIEW_TYPES = ["text", "code"];
  const TEXT_PREVIEW_EXTENSIONS = ["csv", "tsv"];

  function isTextPreviewable(itemEl, type) {
    const name = baseName(itemEl.dataset.path);
    const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
    return TEXT_PREVIEW_TYPES.includes(type) || TEXT_PREVIEW_EXTENSIONS.includes(extension);
  }

  async function showText(frameEl, path, requestId) {
    try {
      const text = await window.__TAURI__.core.invoke("read_text_preview", { path });
      if (requestId !== previewId) return;
      const textEl = document.createElement("pre");
      textEl.className = "text-view";
      textEl.textContent = text;
      frameEl.classList.remove("file-frame");
      frameEl.replaceChildren(textEl);
    } catch (error) {
      // Keep the file icon when the file can't be read as text.
      console.error("Could not load text preview:", error);
    }
  }

  function showFile(itemEl) {
    const requestId = nextPreview();
    const path = itemEl.dataset.path;
    const type = [...itemEl.classList].find((c) => c.startsWith("entry-type-")).slice("entry-type-".length);
    const viewerEl = document.createElement("div");
    viewerEl.className = "image-viewer";
    const frameEl = document.createElement("div");
    frameEl.className = "image-frame file-frame";
    frameEl.append(createIcon(type, itemEl.classList.contains("entry-shortcut"), 96));
    viewerEl.append(frameEl, previewCaption(path));
    rightPanelEl.replaceChildren(viewerEl);
    if (isTextPreviewable(itemEl, type)) {
      showText(frameEl, path, requestId);
    }
  }

  const VIDEO_ICONS = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextAnimationFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
  }

  // Videos are decoded by the bundled libVLC; frames are pulled from the `vlcframe` scheme
  // and painted on a canvas, so formats the webview can't play still preview.
  async function showVideo(itemEl) {
    const requestId = nextPreview();
    const path = itemEl.dataset.path;
    const name = baseName(path);
    const invoke = window.__TAURI__.core.invoke;

    const viewerEl = document.createElement("div");
    viewerEl.className = "image-viewer";
    const frameEl = document.createElement("div");
    frameEl.className = "image-frame file-frame";
    frameEl.append(createIcon("video", itemEl.classList.contains("entry-shortcut"), 96));

    const canvasEl = document.createElement("canvas");
    canvasEl.className = "video-view";
    const overlayEl = document.createElement("button");
    overlayEl.type = "button";
    overlayEl.className = "video-play-overlay";
    overlayEl.setAttribute("aria-label", "Play");
    overlayEl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${VIDEO_ICONS.play}</svg>`;

    const controlsEl = document.createElement("div");
    controlsEl.className = "video-controls";
    controlsEl.hidden = true;
    const playButtonEl = document.createElement("button");
    playButtonEl.type = "button";
    playButtonEl.className = "nav-button video-button";
    const seekEl = document.createElement("input");
    seekEl.type = "range";
    seekEl.className = "video-seek";
    seekEl.min = "0";
    seekEl.max = "0";
    seekEl.value = "0";
    seekEl.setAttribute("aria-label", "Seek");
    const timeEl = document.createElement("span");
    timeEl.className = "video-time";
    controlsEl.append(playButtonEl, seekEl, timeEl);

    viewerEl.append(frameEl, controlsEl, previewCaption(path));
    rightPanelEl.replaceChildren(viewerEl);
    rightPanelEl.scrollTop = 0;

    let id = null;
    let stopped = false;
    let state = "paused";
    let lengthMs = 0;
    let seeking = false;
    stopActiveVideo = () => {
      stopped = true;
      if (id !== null) invoke("video_close", { id }).catch(() => {});
    };

    function render(timeMs) {
      const playing = state === "playing";
      const label = playing ? "Pause" : "Play";
      playButtonEl.title = label;
      playButtonEl.setAttribute("aria-label", label);
      playButtonEl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${playing ? VIDEO_ICONS.pause : VIDEO_ICONS.play}</svg>`;
      overlayEl.hidden = playing;
      if (timeMs !== undefined) {
        seekEl.max = String(lengthMs);
        if (!seeking) seekEl.value = String(timeMs);
        timeEl.textContent = `${formatDuration(seeking ? Number(seekEl.value) : timeMs)} / ${formatDuration(lengthMs)}`;
      }
    }

    function showError() {
      stopActiveVideo?.();
      stopActiveVideo = null;
      const messageEl = document.createElement("p");
      messageEl.className = "grid-message";
      messageEl.textContent = `Cannot play ${name}`;
      frameEl.replaceChildren(messageEl);
      controlsEl.hidden = true;
    }

    async function togglePlay() {
      const playing = state === "playing";
      state = playing ? "paused" : "playing";
      render();
      try {
        await invoke(playing ? "video_pause" : "video_play", { id });
      } catch (error) {
        console.error("Video control failed:", error);
      }
    }

    async function pumpFrames() {
      const context = canvasEl.getContext("2d");
      const frameUrl = window.__TAURI__.core.convertFileSrc("frame", "vlcframe");
      let seq = 0;
      while (!stopped) {
        try {
          const response = await fetch(`${frameUrl}?id=${id}&after=${seq}`, { cache: "no-store" });
          if (response.status === 200) {
            const buffer = await response.arrayBuffer();
            if (stopped) break;
            const header = new DataView(buffer, 0, 12);
            const width = header.getUint32(0, true);
            const height = header.getUint32(4, true);
            seq = header.getUint32(8, true);
            if (canvasEl.width !== width || canvasEl.height !== height) {
              canvasEl.width = width;
              canvasEl.height = height;
            }
            context.putImageData(new ImageData(new Uint8ClampedArray(buffer, 12, width * height * 4), width, height), 0, 0);
            if (!canvasEl.isConnected) {
              frameEl.classList.remove("file-frame");
              frameEl.replaceChildren(canvasEl, overlayEl);
              controlsEl.hidden = false;
            }
          }
        } catch (error) {
          console.error("Could not fetch video frame:", error);
          await wait(500);
        }
        // Poll every display frame while playing, slowly while paused.
        await (state === "playing" ? nextAnimationFrame() : wait(200));
      }
    }

    async function pollStatus() {
      while (!stopped) {
        try {
          const status = await invoke("video_status", { id });
          if (stopped) break;
          if (status.state === "error") {
            showError();
            break;
          }
          // libVLC reports "loading" while opening or buffering.
          if (status.state !== "loading") state = status.state;
          lengthMs = status.lengthMs;
          render(status.timeMs);
        } catch {
          break;
        }
        await wait(250);
      }
    }

    overlayEl.addEventListener("click", togglePlay);
    canvasEl.addEventListener("click", togglePlay);
    playButtonEl.addEventListener("click", togglePlay);
    seekEl.addEventListener("input", () => {
      seeking = true;
      timeEl.textContent = `${formatDuration(Number(seekEl.value))} / ${formatDuration(lengthMs)}`;
    });
    seekEl.addEventListener("change", async () => {
      try {
        await invoke("video_seek", { id, timeMs: Number(seekEl.value) });
      } catch (error) {
        console.error("Video seek failed:", error);
      } finally {
        seeking = false;
      }
    });

    try {
      const scale = window.devicePixelRatio || 1;
      id = await invoke("video_open", {
        path,
        maxWidth: Math.round(frameEl.clientWidth * scale),
        maxHeight: Math.round(frameEl.clientHeight * scale),
      });
    } catch (error) {
      if (requestId !== previewId) return;
      console.error("Could not open video:", error);
      statusBarEl.textContent = `Cannot play ${name}`;
      showError();
      return;
    }
    if (stopped) {
      invoke("video_close", { id }).catch(() => {});
      return;
    }
    render(0);
    pumpFrames();
    pollStatus();
  }

  async function showPreview(itemEl) {
    if (itemEl.classList.contains("entry-type-image")) {
      showImage(itemEl.dataset.path);
      return;
    }
    if (itemEl.classList.contains("entry-type-video")) {
      showVideo(itemEl);
      return;
    }
    if (itemEl.classList.contains("entry-file")) {
      showFile(itemEl);
      return;
    }
    if (!itemEl.classList.contains("entry-dir")) {
      clearPreview();
      return;
    }
    const requestId = nextPreview();
    const path = itemEl.dataset.path;
    try {
      const entries = await window.__TAURI__.core.invoke("load_file_folder", { path });
      if (requestId !== previewId) return;
      renderGrid(rightPanelEl, entries);
      rightPanelEl.scrollTop = 0;
    } catch (error) {
      if (requestId !== previewId) return;
      console.error("Could not load folder preview:", error);
      const messageEl = document.createElement("p");
      messageEl.className = "grid-message";
      messageEl.textContent = `Could not open ${baseName(path)}`;
      rightPanelEl.replaceChildren(messageEl);
    }
  }

  function selectEntry(itemEl) {
    if (itemEl.classList.contains("selected")) return;
    for (const selectedEl of leftPanelEl.querySelectorAll(".entry.selected")) {
      selectedEl.classList.remove("selected");
      selectedEl.setAttribute("aria-selected", "false");
    }
    itemEl.classList.add("selected");
    itemEl.setAttribute("aria-selected", "true");
    itemEl.scrollIntoView({ block: "nearest" });
    showPreview(itemEl);
  }

  leftPanelEl.addEventListener("click", (e) => {
    const itemEl = e.target.closest(".entry");
    if (itemEl && leftPanelEl.contains(itemEl)) {
      selectEntry(itemEl);
    }
  });

  async function openEntry(itemEl) {
    const path = itemEl.dataset.path;
    if (itemEl.classList.contains("entry-dir")) {
      navigateTo(path);
      return;
    }
    try {
      await window.__TAURI__.core.invoke("open_with_default_app", { path });
      statusBarEl.textContent = `Opened ${baseName(path)}`;
    } catch (error) {
      console.error("Could not open item:", error);
      statusBarEl.textContent = `Could not open ${baseName(path)}`;
    }
  }

  leftPanelEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const selectedEl = leftPanelEl.querySelector(".entry.selected");
      if (selectedEl && !e.repeat) {
        e.preventDefault();
        openEntry(selectedEl);
      }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();

    const items = [...leftPanelEl.querySelectorAll(".entry")];
    if (items.length === 0) return;

    const currentIndex = items.findIndex((itemEl) => itemEl.classList.contains("selected"));
    let nextIndex;
    if (currentIndex < 0) {
      nextIndex = e.key === "ArrowDown" ? 0 : items.length - 1;
    } else {
      const step = e.key === "ArrowDown" ? 1 : -1;
      nextIndex = Math.min(Math.max(currentIndex + step, 0), items.length - 1);
    }
    selectEntry(items[nextIndex]);
  });

  rightPanelEl.addEventListener("click", (e) => {
    const itemEl = e.target.closest(".grid-item");
    if (!itemEl || !rightPanelEl.contains(itemEl)) return;
    for (const selectedEl of rightPanelEl.querySelectorAll(".grid-item.selected")) {
      selectedEl.classList.remove("selected");
      selectedEl.setAttribute("aria-selected", "false");
    }
    itemEl.classList.add("selected");
    itemEl.setAttribute("aria-selected", "true");
  });

  function openGridItem(itemEl) {
    if (itemEl.classList.contains("entry-dir")) {
      leftPanelEl.focus();
    }
    openEntry(itemEl);
  }

  rightPanelEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.repeat) return;
    const selectedEl = rightPanelEl.querySelector(".grid-item.selected");
    if (selectedEl) {
      e.preventDefault();
      openGridItem(selectedEl);
    }
  });

  rightPanelEl.addEventListener("dblclick", (e) => {
    const itemEl = e.target.closest(".grid-item");
    if (itemEl && rightPanelEl.contains(itemEl)) {
      openGridItem(itemEl);
    }
  });

  leftPanelEl.addEventListener("dblclick", (e) => {
    const folderEl = e.target.closest(".entry-dir");
    if (folderEl && leftPanelEl.contains(folderEl)) {
      navigateTo(folderEl.dataset.path);
    }
  });

  await navigateTo(currentPath, { updateAddress: !addressEdited });
});

const ROOT_PATTERN = /^(?:[\\/]|[A-Za-z]:[\\/]?)$/;

function normalizePath(path) {
  const trimmed = path.trim();
  if (ROOT_PATTERN.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

function parentPath(path) {
  const normalized = normalizePath(path);
  if (ROOT_PATTERN.test(normalized)) return null;

  const lastSeparator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSeparator < 0) return null;
  if (lastSeparator === 0) return normalized[0];

  const parent = normalized.slice(0, lastSeparator);
  return /^[A-Za-z]:$/.test(parent) ? parent + normalized[lastSeparator] : parent;
}

function baseName(fullPath) {
  return fullPath.split(/[\\/]/).filter(Boolean).pop() ?? fullPath;
}

function entryName(entry) {
  return entry.kind === "file" ? entry.fileName : baseName(entry.fullPath);
}

const KIND_ORDER = { dir: 0, file: 1, inaccessible: 2 };

function sortEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      entryName(a).localeCompare(entryName(b), undefined, { sensitivity: "base", numeric: true }),
  );
}

function renderGrid(containerEl, entries) {
  if (entries.length === 0) {
    const messageEl = document.createElement("p");
    messageEl.className = "grid-message";
    messageEl.textContent = "This folder is empty";
    containerEl.replaceChildren(messageEl);
    return;
  }

  const gridEl = document.createElement("ul");
  gridEl.className = "entry-grid";
  gridEl.setAttribute("role", "listbox");

  for (const entry of sortEntries(entries)) {
    const type = iconType(entry);
    const itemEl = document.createElement("li");
    itemEl.className = `grid-item entry-${entry.kind} entry-type-${type}`;
    itemEl.setAttribute("role", "option");
    itemEl.setAttribute("aria-selected", "false");
    itemEl.title = entry.fullPath;
    itemEl.dataset.path = entry.fullPath;
    if (entry.isShortcut) {
      itemEl.classList.add("entry-shortcut");
    }

    const nameEl = document.createElement("span");
    nameEl.className = "grid-name";
    nameEl.textContent = entryName(entry);
    itemEl.append(createIcon(type, entry.isShortcut, 48), nameEl);
    gridEl.append(itemEl);
  }

  containerEl.replaceChildren(gridEl);
}

function renderEntries(containerEl, entries) {
  const listEl = document.createElement("ul");
  listEl.className = "entry-list";
  listEl.setAttribute("role", "listbox");

  for (const entry of sortEntries(entries)) {
    const type = iconType(entry);
    const itemEl = document.createElement("li");
    itemEl.className = `entry entry-${entry.kind} entry-type-${type}`;
    itemEl.title = entry.fullPath;
    itemEl.dataset.path = entry.fullPath;
    itemEl.setAttribute("role", "option");
    itemEl.setAttribute("aria-selected", "false");
    if (entry.isShortcut) {
      itemEl.classList.add("entry-shortcut");
    }

    const nameEl = document.createElement("span");
    nameEl.className = "entry-name";
    nameEl.textContent = entryName(entry);
    itemEl.append(createIcon(type, entry.isShortcut), nameEl);

    if (entry.kind === "dir") {
      const countEl = document.createElement("span");
      countEl.className = "entry-count";
      countEl.textContent = entry.childrenCount;
      itemEl.append(countEl);
    }

    if (entry.modifiedAt != null) {
      const modified = new Date(entry.modifiedAt);
      const timeEl = document.createElement("time");
      timeEl.className = "entry-modified";
      timeEl.dateTime = modified.toISOString();
      timeEl.textContent = formatModified(modified);
      timeEl.title = `Modified ${modified.toLocaleString()}`;
      itemEl.append(timeEl);
    }
    listEl.append(itemEl);
  }

  containerEl.replaceChildren(listEl);
}

function formatModified(date, now = new Date()) {
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
