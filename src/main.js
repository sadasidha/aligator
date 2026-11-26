import { createIcon, iconType } from "./icons.js";

window.addEventListener("DOMContentLoaded", async () => {
  const addressInputEl = document.querySelector("#address-input");
  const statusBarEl = document.querySelector("#status-bar");
  const leftPanelEl = document.querySelector("#left-panel");
  const rightPanelEl = document.querySelector("#right-panel");
  const backButtonEl = document.querySelector("#back-button");
  const forwardButtonEl = document.querySelector("#forward-button");
  const upButtonEl = document.querySelector("#up-button");
  const searchInputEl = document.querySelector("#search-input");
  const searchButtonEl = document.querySelector("#search-button");
  const explorerEl = document.querySelector("#explorer");
  const busyOverlayEl = document.querySelector("#busy-overlay");
  const busyMessageEl = document.querySelector("#busy-message");

  // Blocks all mouse and keyboard input to the window until the returned function is called.
  function lockWindow(message) {
    const focusedEl = document.activeElement;
    explorerEl.inert = true;
    busyMessageEl.textContent = message;
    busyOverlayEl.hidden = false;
    busyOverlayEl.focus();
    return () => {
      explorerEl.inert = false;
      busyOverlayEl.hidden = true;
      if (focusedEl?.isConnected) focusedEl.focus();
    };
  }

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

  // Searches recursively under the current folder and shows the matches as a grid.
  async function search() {
    const query = searchInputEl.value.trim();
    const path = historyIndex >= 0 ? history[historyIndex] : null;
    if (!query || path === null) return;

    // Searching replaces the preview, so stale previews and older searches are ignored.
    const requestId = nextPreview();
    for (const selectedEl of leftPanelEl.querySelectorAll(".entry.selected")) {
      selectedEl.classList.remove("selected");
      selectedEl.setAttribute("aria-selected", "false");
    }
    const messageEl = document.createElement("p");
    messageEl.className = "grid-message";
    messageEl.textContent = `Searching for “${query}”…`;
    rightPanelEl.replaceChildren(messageEl);
    statusBarEl.textContent = `Searching ${baseName(path)}…`;

    try {
      const { entries, truncated } = await window.__TAURI__.core.invoke("search_file_folder", { path, query });
      if (requestId !== previewId) return;
      renderGrid(rightPanelEl, entries, { emptyMessage: `No results for “${query}”` });
      rightPanelEl.scrollTop = 0;
      statusBarEl.textContent = truncated
        ? `Showing the first ${entries.length} results for “${query}”`
        : `${entries.length} results for “${query}”`;
    } catch (error) {
      if (requestId !== previewId) return;
      console.error("Search failed:", error);
      messageEl.textContent = `Could not search ${baseName(path)}`;
      statusBarEl.textContent = `Search failed in ${path}`;
    }
  }

  searchButtonEl.addEventListener("click", search);
  searchInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.repeat) {
      search();
    }
  });

  // Ignores responses for folders that are no longer selected.
  let previewId = 0;
  // Releases resources held by the current preview (libVLC player, PDF document), if any.
  let stopActivePreview = null;

  function nextPreview() {
    stopActivePreview?.();
    stopActivePreview = null;
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
  const CROP_ICON = '<path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14"/>';
  const SAVABLE_EXTENSIONS = ["png", "jpg", "jpeg", "bmp", "tif", "tiff"];

  async function alertDialog(message) {
    const dialog = window.__TAURI__.dialog;
    return dialog ? dialog.message(message, { title: "Image Editor", kind: "error" }) : window.alert(message);
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
    frameEl.className = "image-frame editable-frame";
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

    const caption = previewCaption(path);

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

    let busy = false;
    function setBusy(value) {
      busy = value;
      toolbarEl.querySelectorAll("button").forEach((el) => (el.disabled = value));
    }

    async function save(destination, transforms = pending) {
      setBusy(true);
      let unlockWindow = lockWindow(`Saving ${baseName(destination ?? path)}…`);
      try {
        await window.__TAURI__.core.invoke("transform_image", { path, transforms, destination });
        exitCrop();
        if (destination) {
          setPending([]);
          statusBarEl.textContent = `Saved as ${baseName(destination)}`;
        } else {
          saveGroupEl.hidden = true;
          statusBarEl.textContent = `Saved ${name}`;
          caption.refresh();
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
        unlockWindow();
        unlockWindow = () => {};
        console.error("Could not save image:", error);
        exitCrop();
        setPending([]);
        statusBarEl.textContent = `Failed to save ${name}`;
        await alertDialog(`Failed to save ${name}.\n${error}`);
      } finally {
        unlockWindow();
        setBusy(false);
      }
    }

    async function saveAs(transforms = pending) {
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
        await save(destination, transforms);
      }
    }

    function textButton(label, title, onClick) {
      const buttonEl = document.createElement("button");
      buttonEl.type = "button";
      buttonEl.className = "text-button";
      buttonEl.textContent = label;
      buttonEl.title = title;
      buttonEl.addEventListener("click", onClick);
      return buttonEl;
    }

    function iconButton(label, icon, onClick) {
      const buttonEl = document.createElement("button");
      buttonEl.type = "button";
      buttonEl.className = "nav-button";
      buttonEl.title = label;
      buttonEl.setAttribute("aria-label", label);
      buttonEl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      buttonEl.addEventListener("click", onClick);
      return buttonEl;
    }

    const editGroupEl = document.createElement("span");
    editGroupEl.className = "image-tool-group";
    for (const [transform, { label, icon }] of Object.entries(PREVIEW_TRANSFORMS)) {
      editGroupEl.append(iconButton(label, icon, () => setPending([...pending, transform])));
    }
    editGroupEl.append(iconButton("Crop", CROP_ICON, () => enterCrop()));

    saveGroupEl.append(
      textButton("Save", `Overwrite ${name}`, () => save(null)),
      textButton("Save as…", "Save the edited image as a new file", () => saveAs()),
    );

    // The crop area is kept as fractions of the image as currently displayed (after any
    // pending rotations and flips), which is how the backend applies it after those edits.
    const MIN_CROP_PX = 8;
    let selection = null;
    let cropResizeObserver = null;

    const cropOverlayEl = document.createElement("div");
    cropOverlayEl.className = "crop-overlay";
    cropOverlayEl.tabIndex = -1;
    cropOverlayEl.hidden = true;
    const cropShadeEl = document.createElement("div");
    cropShadeEl.className = "crop-shade";
    const cropBoxEl = document.createElement("div");
    cropBoxEl.className = "crop-box";
    const cropSizeEl = document.createElement("span");
    cropSizeEl.className = "crop-size";
    cropBoxEl.append(cropSizeEl);
    for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const handleEl = document.createElement("span");
      handleEl.className = "crop-handle";
      handleEl.dataset.handle = handle;
      cropBoxEl.append(handleEl);
    }
    const cropMaskEl = document.createElement("div");
    cropMaskEl.className = "crop-mask";
    cropMaskEl.append(cropShadeEl);
    cropOverlayEl.append(cropMaskEl, cropBoxEl);
    frameEl.append(cropOverlayEl);

    const cropGroupEl = document.createElement("span");
    cropGroupEl.className = "image-save-group";
    cropGroupEl.hidden = true;
    cropGroupEl.append(
      textButton("Save", `Crop and overwrite ${name}`, () => save(null, cropTransforms())),
      textButton("Save as…", "Crop and save as a new file", () => saveAs(cropTransforms())),
      textButton("Cancel", "Cancel cropping", () => exitCrop()),
    );

    function cropTransforms() {
      const { x, y, w, h } = selection;
      return [...pending, { crop: { x, y, width: w, height: h } }];
    }

    function displayedPixelSize() {
      const quarterTurn = imageEl.classList.contains("quarter-turn");
      return quarterTurn
        ? { width: imageEl.naturalHeight, height: imageEl.naturalWidth }
        : { width: imageEl.naturalWidth, height: imageEl.naturalHeight };
    }

    function renderSelection() {
      const { x, y, w, h } = selection;
      for (const el of [cropShadeEl, cropBoxEl]) {
        el.style.left = `${x * 100}%`;
        el.style.top = `${y * 100}%`;
        el.style.width = `${w * 100}%`;
        el.style.height = `${h * 100}%`;
      }
      const { width, height } = displayedPixelSize();
      const pixels = (start, size, total) => Math.round((start + size) * total) - Math.round(start * total);
      cropSizeEl.textContent = `${pixels(x, w, width)} × ${pixels(y, h, height)}`;
    }

    function layoutCropOverlay() {
      if (!frameEl.isConnected) {
        cropResizeObserver?.disconnect();
        return;
      }
      const frameRect = frameEl.getBoundingClientRect();
      const imageRect = imageEl.getBoundingClientRect();
      cropOverlayEl.style.left = `${imageRect.left - frameRect.left}px`;
      cropOverlayEl.style.top = `${imageRect.top - frameRect.top}px`;
      cropOverlayEl.style.width = `${imageRect.width}px`;
      cropOverlayEl.style.height = `${imageRect.height}px`;
    }

    async function enterCrop() {
      if (selection) return;
      setBusy(true);
      // Measure the image only once it has loaded and any rotate/flip animation has settled.
      await imageEl.decode().catch(() => {});
      await Promise.all(imageEl.getAnimations().map((animation) => animation.finished)).catch(() => {});
      setBusy(false);
      if (!frameEl.isConnected || selection) return;

      selection = { x: 0, y: 0, w: 1, h: 1 };
      editGroupEl.hidden = true;
      saveGroupEl.hidden = true;
      cropGroupEl.hidden = false;
      cropOverlayEl.hidden = false;
      layoutCropOverlay();
      renderSelection();
      cropResizeObserver = new ResizeObserver(layoutCropOverlay);
      cropResizeObserver.observe(frameEl);
      document.addEventListener("keydown", onCropKeydown, true);
      cropOverlayEl.focus();
      statusBarEl.textContent = "Drag to choose the crop area · Enter to save · Esc to cancel";
    }

    function exitCrop() {
      if (!selection) return;
      selection = null;
      cropResizeObserver?.disconnect();
      cropResizeObserver = null;
      document.removeEventListener("keydown", onCropKeydown, true);
      cropOverlayEl.hidden = true;
      cropGroupEl.hidden = true;
      editGroupEl.hidden = false;
      saveGroupEl.hidden = pending.length === 0;
    }

    // Captured on the document so the shortcuts work wherever focus is, and so Enter
    // doesn't also reach the file list (which would open the file).
    function onCropKeydown(e) {
      if (!frameEl.isConnected) {
        document.removeEventListener("keydown", onCropKeydown, true);
        return;
      }
      if (e.key !== "Enter" && e.key !== "Escape") return;
      // Leave typing in the address/search boxes and activating focused buttons alone.
      if (e.target.closest?.("input, textarea")) return;
      if (e.key === "Enter" && e.target.closest?.("button")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || busy) return;
      if (e.key === "Enter") {
        save(null, cropTransforms());
      } else {
        exitCrop();
      }
    }

    cropOverlayEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !selection) return;
      e.preventDefault();
      cropOverlayEl.focus();
      const bounds = cropOverlayEl.getBoundingClientRect();
      const minW = Math.min(MIN_CROP_PX / bounds.width, 1);
      const minH = Math.min(MIN_CROP_PX / bounds.height, 1);
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const pointAt = (event) => ({
        x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
        y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
      });
      const start = pointAt(e);
      const origin = { ...selection };
      const mode = e.target.dataset.handle ?? (cropBoxEl.contains(e.target) ? "move" : "new");

      function onMove(event) {
        const point = pointAt(event);
        if (mode === "move") {
          selection.x = clamp(origin.x + point.x - start.x, 0, 1 - origin.w);
          selection.y = clamp(origin.y + point.y - start.y, 0, 1 - origin.h);
        } else if (mode === "new") {
          selection = {
            x: Math.min(start.x, point.x),
            y: Math.min(start.y, point.y),
            w: Math.abs(point.x - start.x),
            h: Math.abs(point.y - start.y),
          };
        } else {
          let left = origin.x;
          let top = origin.y;
          let right = origin.x + origin.w;
          let bottom = origin.y + origin.h;
          if (mode.includes("w")) left = Math.min(point.x, right - minW);
          if (mode.includes("e")) right = Math.max(point.x, left + minW);
          if (mode.includes("n")) top = Math.min(point.y, bottom - minH);
          if (mode.includes("s")) bottom = Math.max(point.y, top + minH);
          selection = { x: left, y: top, w: right - left, h: bottom - top };
        }
        renderSelection();
      }

      function onEnd() {
        cropOverlayEl.removeEventListener("pointermove", onMove);
        cropOverlayEl.removeEventListener("pointerup", onEnd);
        cropOverlayEl.removeEventListener("pointercancel", onEnd);
        // A click without a real drag keeps the previous area.
        if (selection && (selection.w < minW || selection.h < minH)) {
          selection = origin;
          renderSelection();
        }
      }

      cropOverlayEl.setPointerCapture(e.pointerId);
      cropOverlayEl.addEventListener("pointermove", onMove);
      cropOverlayEl.addEventListener("pointerup", onEnd);
      cropOverlayEl.addEventListener("pointercancel", onEnd);
    });

    toolbarEl.append(editGroupEl, saveGroupEl, cropGroupEl);

    viewerEl.append(toolbarEl, frameEl, caption.el);
    rightPanelEl.replaceChildren(viewerEl);
    rightPanelEl.scrollTop = 0;
  }

  // The file name plus a line of file details and, for images and videos, a line of media details.
  function previewCaption(path) {
    const el = document.createElement("div");
    el.className = "preview-caption";
    const nameEl = document.createElement("div");
    nameEl.className = "preview-name";
    nameEl.textContent = baseName(path);
    nameEl.title = path;
    const fileLineEl = document.createElement("div");
    fileLineEl.className = "preview-info";
    const mediaLineEl = document.createElement("div");
    mediaLineEl.className = "preview-info";
    el.append(nameEl, fileLineEl, mediaLineEl);

    const setLine = (lineEl, parts) => {
      lineEl.textContent = parts.filter(Boolean).join("  ·  ");
      lineEl.hidden = !lineEl.textContent;
    };
    setLine(fileLineEl, []);
    setLine(mediaLineEl, []);

    async function refresh() {
      const requestId = previewId;
      try {
        const info = await window.__TAURI__.core.invoke("file_info", { path });
        if (requestId !== previewId) return;
        setLine(fileLineEl, [
          formatSize(info.size),
          info.modifiedAt != null && `Updated ${new Date(info.modifiedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
        ]);
        if (info.image) setLine(mediaLineEl, imageInfoParts(info.image));
      } catch (error) {
        console.error("Could not load file info:", error);
      }
    }
    refresh();

    return { el, refresh, setMediaInfo: (parts) => setLine(mediaLineEl, parts) };
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
    viewerEl.append(frameEl, previewCaption(path).el);
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

    const caption = previewCaption(path);
    viewerEl.append(frameEl, controlsEl, caption.el);
    rightPanelEl.replaceChildren(viewerEl);
    rightPanelEl.scrollTop = 0;

    let id = null;
    let stopped = false;
    let state = "paused";
    let lengthMs = 0;
    let seeking = false;
    stopActivePreview = () => {
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
      stopActivePreview?.();
      stopActivePreview = null;
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
    invoke("video_info", { id })
      .then((info) => {
        if (!stopped) caption.setMediaInfo(videoInfoParts(info));
      })
      .catch((error) => console.error("Could not load video info:", error));
    pumpFrames();
    pollStatus();
  }

  const PDF_ICONS = {
    previous: '<path d="M6 15l6-6 6 6"/>',
    next: '<path d="M6 9l6 6 6-6"/>',
  };

  let pdfjsPromise = null;
  function loadPdfjs() {
    pdfjsPromise ??= import("./vendor/pdfjs/pdf.min.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
      return pdfjs;
    });
    pdfjsPromise.catch(() => (pdfjsPromise = null));
    return pdfjsPromise;
  }

  // Renders one page at a time with pdf.js, fitted to the preview area.
  async function showPdf(itemEl) {
    const requestId = nextPreview();
    const path = itemEl.dataset.path;
    const name = baseName(path);

    const viewerEl = document.createElement("div");
    viewerEl.className = "image-viewer";
    const toolbarEl = document.createElement("div");
    toolbarEl.className = "image-toolbar pdf-toolbar";
    toolbarEl.hidden = true;
    const frameEl = document.createElement("div");
    frameEl.className = "image-frame file-frame";
    frameEl.append(createIcon("pdf", itemEl.classList.contains("entry-shortcut"), 96));
    const caption = previewCaption(path);
    viewerEl.append(toolbarEl, frameEl, caption.el);
    rightPanelEl.replaceChildren(viewerEl);
    rightPanelEl.scrollTop = 0;

    function pageButton(label, icon, onClick) {
      const buttonEl = document.createElement("button");
      buttonEl.type = "button";
      buttonEl.className = "nav-button";
      buttonEl.title = label;
      buttonEl.setAttribute("aria-label", label);
      buttonEl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`;
      buttonEl.addEventListener("click", onClick);
      return buttonEl;
    }
    const previousButtonEl = pageButton("Previous page (↑)", PDF_ICONS.previous, () => goTo(pageNumber - 1));
    const nextButtonEl = pageButton("Next page (↓)", PDF_ICONS.next, () => goTo(pageNumber + 1));
    const pageInputEl = document.createElement("input");
    // A text box rather than type="number": the native spinner counts down on ▼, but here down means the next page.
    pageInputEl.type = "text";
    pageInputEl.inputMode = "numeric";
    pageInputEl.autocomplete = "off";
    pageInputEl.spellcheck = false;
    pageInputEl.className = "pdf-page-input";
    pageInputEl.setAttribute("aria-label", "Page number");
    const pageCountEl = document.createElement("span");
    pageCountEl.className = "pdf-page-count";

    // Edits are kept per page (rotate/flip as seen on screen) until the user saves them.
    const pendingEdits = new Map();
    const editGroupEl = document.createElement("span");
    editGroupEl.className = "image-tool-group pdf-edit-group";
    for (const [transform, { label, icon }] of Object.entries(PREVIEW_TRANSFORMS)) {
      editGroupEl.append(pageButton(`${label} (this page)`, icon, () => editPage(transform)));
    }
    const saveGroupEl = document.createElement("span");
    saveGroupEl.className = "image-save-group";
    saveGroupEl.hidden = true;
    function textButton(label, title, onClick) {
      const buttonEl = document.createElement("button");
      buttonEl.type = "button";
      buttonEl.className = "text-button";
      buttonEl.textContent = label;
      buttonEl.title = title;
      buttonEl.addEventListener("click", onClick);
      return buttonEl;
    }
    saveGroupEl.append(
      textButton("Save", `Overwrite ${name}`, () => save(null)),
      textButton("Save as…", "Save the edited PDF as a new file", () => saveAs()),
    );
    toolbarEl.append(previousButtonEl, nextButtonEl, pageInputEl, pageCountEl, editGroupEl, saveGroupEl);

    const canvasEl = document.createElement("canvas");
    canvasEl.className = "pdf-page";

    let pdf = null;
    let loadingTask = null;
    let renderTask = null;
    let resizeObserver = null;
    let pageNumber = 1;
    let stopped = false;
    let busy = false;
    stopActivePreview = () => {
      stopped = true;
      resizeObserver?.disconnect();
      rightPanelEl.removeEventListener("keydown", onKeydown);
      renderTask?.cancel();
      (pdf ?? loadingTask)?.destroy();
    };

    // Folds a page's pending edits into an extra clockwise rotation followed by on-screen flips.
    function pageView(number) {
      let angle = 0;
      let flipX = false;
      let flipY = false;
      for (const transform of pendingEdits.get(number) ?? []) {
        if (transform === "rotate90") {
          // Turning a flipped page swaps which screen axis the flip is on.
          angle = (angle + 90) % 360;
          [flipX, flipY] = [flipY, flipX];
        } else if (transform === "flipHorizontal") {
          flipX = !flipX;
        } else {
          flipY = !flipY;
        }
      }
      return { angle, flipX, flipY };
    }

    function editedPageCount() {
      return [...pendingEdits.keys()].filter((number) => {
        const { angle, flipX, flipY } = pageView(number);
        return angle || flipX || flipY;
      }).length;
    }

    function updateStatus() {
      const edited = editedPageCount();
      saveGroupEl.hidden = edited === 0;
      const editedText = edited ? ` · ${edited} ${edited === 1 ? "page" : "pages"} edited` : "";
      statusBarEl.textContent = `${name} — page ${pageNumber} of ${pdf.numPages}${editedText}`;
    }

    function editPage(transform) {
      if (!pdf || busy) return;
      pendingEdits.set(pageNumber, [...(pendingEdits.get(pageNumber) ?? []), transform]);
      updateStatus();
      renderPage();
    }

    function setBusy(value) {
      busy = value;
      toolbarEl.querySelectorAll("button, input").forEach((el) => (el.disabled = value));
      if (!value && pdf) {
        previousButtonEl.disabled = pageNumber <= 1;
        nextButtonEl.disabled = pageNumber >= pdf.numPages;
      }
    }

    function pdfEditedCopyPath() {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      return `${path.slice(0, path.length - name.length)}${stem}-edited.pdf`;
    }

    async function save(destination) {
      if (!pdf || busy) return;
      const edits = [...pendingEdits]
        .filter(([number]) => {
          const { angle, flipX, flipY } = pageView(number);
          return angle || flipX || flipY;
        })
        .map(([page, transforms]) => ({ page, transforms }));
      setBusy(true);
      let unlockWindow = lockWindow(`Saving ${baseName(destination ?? path)}…`);
      try {
        await window.__TAURI__.core.invoke("transform_pdf", { path, edits, destination });
        if (destination) {
          pendingEdits.clear();
          renderPage();
          updateStatus();
          statusBarEl.textContent = `Saved as ${baseName(destination)}`;
        } else {
          // Reopen the saved file before dropping the pending edits so the page never flashes back.
          const saved = await openPdf();
          if (stopped) {
            saved.destroy();
            return;
          }
          const previous = pdf;
          pdf = saved;
          pendingEdits.clear();
          await renderPage();
          previous.destroy();
          caption.refresh();
          updateStatus();
          statusBarEl.textContent = `Saved ${name}`;
        }
      } catch (error) {
        unlockWindow();
        unlockWindow = () => {};
        console.error("Could not save PDF:", error);
        statusBarEl.textContent = `Failed to save ${name}`;
        await alertDialog(`Failed to save ${name}.\n${error}`);
      } finally {
        unlockWindow();
        setBusy(false);
      }
    }

    async function saveAs() {
      const dialog = window.__TAURI__.dialog;
      if (!dialog || !pdf || busy) return;
      setBusy(true);
      let destination;
      try {
        destination = await dialog.save({
          defaultPath: pdfEditedCopyPath(),
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
      } finally {
        setBusy(false);
      }
      if (destination) {
        await save(destination);
      }
    }

    function showError(message) {
      const messageEl = document.createElement("p");
      messageEl.className = "grid-message";
      messageEl.textContent = message;
      frameEl.classList.add("file-frame");
      frameEl.replaceChildren(messageEl);
      toolbarEl.hidden = true;
    }

    async function renderPage() {
      const number = pageNumber;
      renderTask?.cancel();
      renderTask = null;
      try {
        const page = await pdf.getPage(number);
        if (stopped || number !== pageNumber) return;
        const { angle, flipX, flipY } = pageView(number);
        const rotation = (page.rotate + angle) % 360;
        // Fit the page inside the frame, then render at device resolution for sharp text.
        const unscaled = page.getViewport({ scale: 1, rotation });
        const margin = 16;
        const fit = Math.min(
          (frameEl.clientWidth - margin) / unscaled.width,
          (frameEl.clientHeight - margin) / unscaled.height,
        );
        if (!(fit > 0)) return;
        const outputScale = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: fit * outputScale, rotation });
        // Draw off-screen first so the old page stays visible until the new one is ready.
        const targetEl = document.createElement("canvas");
        targetEl.width = Math.floor(viewport.width);
        targetEl.height = Math.floor(viewport.height);
        renderTask?.cancel();
        renderTask = page.render({ canvas: targetEl, canvasContext: targetEl.getContext("2d"), viewport });
        await renderTask.promise;
        if (stopped || number !== pageNumber) return;
        canvasEl.width = targetEl.width;
        canvasEl.height = targetEl.height;
        canvasEl.style.width = `${targetEl.width / outputScale}px`;
        canvasEl.style.height = `${targetEl.height / outputScale}px`;
        canvasEl.style.transform = flipX || flipY ? `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : "";
        canvasEl.getContext("2d").drawImage(targetEl, 0, 0);
        if (!canvasEl.isConnected) {
          frameEl.classList.remove("file-frame");
          frameEl.replaceChildren(canvasEl);
        }
      } catch (error) {
        if (stopped || error?.name === "RenderingCancelledException") return;
        console.error("Could not render PDF page:", error);
        showError(`Cannot show page ${number} of ${name}`);
      }
    }

    function goTo(number) {
      if (!pdf) return;
      const clamped = Math.min(Math.max(Math.round(number) || 1, 1), pdf.numPages);
      pageInputEl.value = String(clamped);
      if (clamped === pageNumber && canvasEl.isConnected) return;
      pageNumber = clamped;
      previousButtonEl.disabled = pageNumber <= 1;
      nextButtonEl.disabled = pageNumber >= pdf.numPages;
      updateStatus();
      renderPage();
    }

    function onKeydown(e) {
      if (!pdf || busy || e.altKey || e.ctrlKey || e.metaKey) return;
      // The page box handles its own arrows and Enter.
      if (e.target === pageInputEl) return;
      const target = {
        ArrowUp: pageNumber - 1,
        PageUp: pageNumber - 1,
        ArrowLeft: pageNumber - 1,
        ArrowDown: pageNumber + 1,
        PageDown: pageNumber + 1,
        ArrowRight: pageNumber + 1,
        Home: 1,
        End: pdf.numPages,
      }[e.key];
      if (target === undefined) return;
      e.preventDefault();
      goTo(target);
    }

    function goToTyped() {
      const typed = Number.parseInt(pageInputEl.value.trim(), 10);
      if (Number.isFinite(typed)) {
        goTo(typed);
      } else {
        pageInputEl.value = String(pageNumber);
      }
    }

    pageInputEl.addEventListener("change", goToTyped);
    pageInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        goToTyped();
        pageInputEl.select();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        goTo(pageNumber + (e.key === "ArrowDown" ? 1 : -1));
        pageInputEl.select();
      } else if (e.key === "Escape") {
        pageInputEl.value = String(pageNumber);
        rightPanelEl.focus();
      }
    });
    pageInputEl.addEventListener("focus", () => pageInputEl.select());
    // Clicking the page gives the preview keyboard focus so Up/Down turn pages.
    frameEl.addEventListener("pointerdown", () => rightPanelEl.focus());

    async function openPdf() {
      const pdfjs = await loadPdfjs();
      const base = new URL("./vendor/pdfjs/", import.meta.url).href;
      const task = pdfjs.getDocument({
        // The query string keeps a re-opened file from being served from the cache.
        url: `${window.__TAURI__.core.convertFileSrc(path)}?v=${Date.now()}`,
        // The asset protocol caps each range response, so fetch the whole file at once.
        disableRange: true,
        disableStream: true,
        cMapUrl: `${base}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${base}standard_fonts/`,
        wasmUrl: `${base}wasm/`,
        iccUrl: `${base}iccs/`,
      });
      if (!pdf) loadingTask = task;
      return task.promise;
    }

    try {
      if (stopped) return;
      pdf = await openPdf();
    } catch (error) {
      if (stopped || requestId !== previewId) return;
      console.error("Could not open PDF:", error);
      showError(error?.name === "PasswordException" ? `${name} is password protected` : `Cannot preview ${name}`);
      statusBarEl.textContent = `Cannot preview ${name}`;
      return;
    }
    if (stopped) return;

    pageCountEl.textContent = `/ ${pdf.numPages}`;
    pageInputEl.style.width = `${String(pdf.numPages).length + 3}ch`;
    toolbarEl.hidden = false;
    rightPanelEl.addEventListener("keydown", onKeydown);
    pageNumber = 0;
    goTo(1);

    pdf.getPage(1).then((page) => {
      if (stopped) return;
      const [, , width, height] = page.view;
      caption.setMediaInfo([`${pdf.numPages} ${pdf.numPages === 1 ? "page" : "pages"}`, pdfPageSize(width, height)]);
    }).catch(() => {});

    let resizeTimer = 0;
    resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => !stopped && renderPage(), 100);
    });
    resizeObserver.observe(frameEl);
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
    if (itemEl.classList.contains("entry-type-pdf")) {
      showPdf(itemEl);
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

function renderGrid(containerEl, entries, { emptyMessage = "This folder is empty" } = {}) {
  if (entries.length === 0) {
    const messageEl = document.createElement("p");
    messageEl.className = "grid-message";
    messageEl.textContent = emptyMessage;
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

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];

function formatSize(bytes) {
  const exact = `${bytes.toLocaleString()} bytes`;
  if (bytes < 1024) return exact;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < SIZE_UNITS.length - 1);
  return `${exact} (${value.toFixed(value < 10 ? 1 : 0)} ${SIZE_UNITS[unit]})`;
}

const roundTo = (value, digits) => Number(value.toFixed(digits));

function imageInfoParts(image) {
  const { x, y } = image.resolution ?? {};
  return [
    image.format,
    `${image.width} × ${image.height} px (${roundTo((image.width * image.height) / 1e6, 1)} MP)`,
    image.bitsPerChannel ? `${image.colorModel}, ${image.bitsPerChannel}-bit` : image.colorModel,
    image.resolution && (roundTo(x, 0) === roundTo(y, 0) ? `${roundTo(x, 0)} ppi` : `${roundTo(x, 0)} × ${roundTo(y, 0)} ppi`),
  ];
}

function videoInfoParts(video) {
  const audio = video.audioCodec && [
    video.audioCodec,
    video.audioChannels && (video.audioChannels === 1 ? "mono" : video.audioChannels === 2 ? "stereo" : `${video.audioChannels} ch`),
    video.audioSampleRate && `${roundTo(video.audioSampleRate / 1000, 1)} kHz`,
  ].filter(Boolean).join(" ");
  return [
    video.width > 0 && `${video.width} × ${video.height} px`,
    video.frameRate && `${roundTo(video.frameRate, 2)} fps`,
    video.videoCodec,
    video.videoBitrate && `${roundTo(video.videoBitrate / 1e6, 1)} Mbps`,
    audio && `Audio: ${audio}`,
  ];
}

const PAPER_SIZES = [
  ["A3", 297, 420],
  ["A4", 210, 297],
  ["A5", 148, 210],
  ["B4", 257, 364],
  ["B5", 182, 257],
  ["Letter", 215.9, 279.4],
  ["Legal", 215.9, 355.6],
];

// PDF sizes are in points (1/72 inch).
function pdfPageSize(widthPt, heightPt) {
  const toMm = (pt) => (pt * 25.4) / 72;
  const [short, long] = [toMm(widthPt), toMm(heightPt)].sort((a, b) => a - b);
  const paper = PAPER_SIZES.find(([, w, h]) => Math.abs(w - short) < 2 && Math.abs(h - long) < 2)?.[0];
  const size = `${Math.round(toMm(widthPt))} × ${Math.round(toMm(heightPt))} mm`;
  return paper ? `${paper} (${size})` : size;
}
