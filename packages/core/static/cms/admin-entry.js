import { deepClone, templateFromSchema, generatedId, friendlyFileTitle, singularItemLabel, getTitle, humanizeKey, fieldIdFromPath, getNestedValue, setNestedValue } from './studio/field-model.js';
import { createFieldGroup, createFieldRenderer } from './studio/fields.js';
import { createStudioMutationClient } from './studio/mutation-client.js';
import { createStudioHistoryClient } from './studio/history-client.js';
import { createStudioUploadClient, isSupportedImage } from './studio/upload-client.js';
import { createStudioEntryLoader } from './studio/entry-loader.js';
import { createStudioSync } from './studio/sync-client.js';

/** @typedef {import('../../src/schema-utils.js').JsonSchemaNode} Schema */
/** @typedef {{ path: string, message: string }} ValidationIssue */
/** @typedef {{ apiBasePath?: string, mountPath?: string, collection?: string, id?: string, isNew?: boolean, initializeIfMissing?: boolean, saveTarget?: string, previewPath?: string, editable?: boolean, messages?: Record<string, string> }} EntryConfig */

/**
 * Studio entry editor — runtime.
 *
 * Loaded by the /admin/cms/[collection]/[id] route's HTML shell. Reads its
 * config from <script id="caret-entry-config" type="application/json"> and
 * binds to the page's #cms-entry-page root.
 *
 * Field types supported (schema-driven, with typeof fallback):
 *   text, email, url, textarea, number, boolean, select(enum),
 *   image, image-gallery, tag-list, nested object, array of objects.
 *
 * API surface used:
 *   GET  ${api}/entries?collection=&id=
 *   GET  ${api}/schema?collection=
 *   POST ${api}/mutate   { type: "put_entry" | "delete_entry", ... }
 *   POST ${api}/upload   FormData(file)
 *   GET  ${api}/history?collection=&id=
 *   POST ${api}/history  { collection, id, ts }    // restore snapshot
 *
 * Successful mutations are announced on the same-origin
 * `caretcms:content` BroadcastChannel so an open site preview can refresh
 * automatically. Embedded Studio panels keep using postMessage for their
 * faster in-page field patching.
 */
(function () {
  "use strict";

  var configEl = document.getElementById("caret-entry-config");
  var pageRoot = document.getElementById("cms-entry-page");
  if (!configEl || !pageRoot) return;

  /** @type {EntryConfig} */
  var CFG;
  try {
    CFG = /** @type {EntryConfig} */ (JSON.parse(configEl.textContent || "{}"));
  } catch (e) {
    console.error("[caret] invalid entry config", e);
    return;
  }

  var API = typeof CFG.apiBasePath === "string" ? CFG.apiBasePath : "";
  var MOUNT = typeof CFG.mountPath === "string" ? CFG.mountPath : "";
  var COLLECTION = typeof CFG.collection === "string" ? CFG.collection : "";
  var ID = typeof CFG.id === "string" ? CFG.id : "";
  var IS_NEW = CFG.isNew === true;
  var INITIALIZE_IF_MISSING = CFG.initializeIfMissing === true;
  var SAVE_TARGET = CFG.saveTarget === "preview" ? "preview" : "live";
  var PREVIEW_PATH = typeof CFG.previewPath === "string" ? CFG.previewPath : null;
  /** @type {Record<string, string>} */
  var MSG = CFG.messages || {};
  /** @param {string} key @param {string} fallback */
  function msg(key, fallback) { return typeof MSG[key] === "string" ? MSG[key] : fallback; }
  /** @param {unknown} value */
  function htmlEscape(value) {
    /** @type {Record<string, string>} */
    var entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value).replace(/[&<>"']/g, function (char) {
      return entities[char] || char;
    });
  }
  if (!API || !COLLECTION || !ID) return;
  var mutationClient = createStudioMutationClient({ apiBasePath: API });
  var historyClient = createStudioHistoryClient({ apiBasePath: API });
  var uploadClient = createStudioUploadClient({ apiBasePath: API, onUnauthorized: loginRedirect });
  var entryLoader = createStudioEntryLoader({ apiBasePath: API });

  /* ─── State ─────────────────────────────────────────────────────── */
  /** @type {Record<string, unknown> | null} */
  var entryData = null;
  /** @type {Schema | null} */
  var entrySchema = null;
  /** @type {number | undefined} */
  var entryRevision = undefined;
  var originalJson = "";
  var saving = false;
  var dirtyTimer = 0;
  var linkedSelectionTimer = 0;
  /** @type {Record<string, unknown> | null} */
  var pendingRemoteSelection = null;
  /** @type {string | null} */
  var publicationFieldName = null;
  var studioSync = createStudioSync({
    collection: COLLECTION,
    id: ID,
    previewPath: PREVIEW_PATH,
    origin: window.location.origin,
    isEmbedded: window.parent !== window,
    studioPath: function () { return window.location.pathname + window.location.search; },
    postToParent: function (message) { window.parent.postMessage(message, window.location.origin); },
    onSelection: applyRemoteSelection,
    addWindowMessageListener: function (listener) { window.addEventListener("message", listener); },
    addPagehideListener: function (listener) { window.addEventListener("pagehide", listener, { once: true }); },
    openChannel: "BroadcastChannel" in window ? function (name) { return new BroadcastChannel(name); } : undefined,
  });

  /* ─── DOM refs ──────────────────────────────────────────────────── */
  var loadingEl = /** @type {HTMLElement} */ (document.getElementById("loading"));
  var notFoundEl = /** @type {HTMLElement} */ (document.getElementById("not-found"));
  var editorEl = /** @type {HTMLElement} */ (document.getElementById("editor"));
  var fieldsEl = /** @type {HTMLElement} */ (document.getElementById("fields"));
  var titleEl = /** @type {HTMLElement} */ (document.getElementById("entry-title"));
  var statusEl = /** @type {HTMLElement} */ (document.getElementById("status-msg"));
  var validationWarningEl = /** @type {HTMLElement | null} */ (document.getElementById("validation-warning"));
  var saveBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-save"));
  var deleteBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-delete"));
  var historyBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-history"));
  var historyPanel = /** @type {HTMLElement} */ (document.getElementById("history-panel"));
  var historyList = /** @type {HTMLElement} */ (document.getElementById("history-list"));
  var historyCloseBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-history-close"));
  var deleteDialog = /** @type {HTMLElement} */ (document.getElementById("delete-dialog"));
  var deleteNameEl = /** @type {HTMLElement} */ (document.getElementById("delete-entry-name"));
  var deleteCancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-delete-cancel"));
  var deleteConfirmBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-delete-confirm"));
  /** @type {HTMLElement | null} */
  var deleteRestoreFocus = null;

  /* ─── Helpers ───────────────────────────────────────────────────── */

  function isDirty() {
    return entryData !== null && JSON.stringify(entryData) !== originalJson;
  }

  /** @param {boolean} [preserveStatus] */
  function updateSaveButton(preserveStatus) {
    var dirty = isDirty();
    saveBtn.disabled = CFG.editable === false || !dirty || saving;
    saveBtn.classList.remove("studio-save-dirty", "studio-save-clean", "studio-save-saving");
    saveBtn.classList.add(saving ? "studio-save-saving" : (dirty ? "studio-save-dirty" : "studio-save-clean"));
    saveBtn.textContent = saving ? msg("common.saving", "Saving…") : (SAVE_TARGET === "preview" ? msg("entry.saveDraft", "Save draft") : msg("entry.saveLive", "Save live"));
    titleEl.textContent = getTitle(entryData);
    if (entryData !== null && !preserveStatus) {
      if (saving) showStatus("saving", msg("entry.savingChanges", "Saving changes…"));
      else if (dirty) showStatus("dirty", msg("entry.unsaved", "Unsaved changes"));
      else showStatus("saved", msg("entry.allSaved", "All changes saved"));
    }
  }

  /** @param {string} type @param {string} message */
  function showStatus(type, message) {
    statusEl.textContent = message;
    statusEl.hidden = false;
    statusEl.dataset.status = type;
    statusEl.style.color = type === "saved"
      ? "var(--studio-green)"
      : (type === "dirty" || type === "saving" ? "var(--studio-text-muted)" : "var(--studio-red)");
  }

  /** @param {string} path @param {unknown} value */
  function updateField(path, value) {
    if (!entryData) return;
    setNestedValue(entryData, path, value);
    if (!saving) {
      saveBtn.disabled = CFG.editable === false;
      saveBtn.classList.remove("studio-save-clean", "studio-save-saving");
      saveBtn.classList.add("studio-save-dirty");
    }
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(updateSaveButton, 300);
    studioSync.queuePreview(entryData);
  }

  function loginRedirect() {
    window.location.href = MOUNT + "?redirect=" + encodeURIComponent(window.location.pathname);
  }

  /** @param {Response} res */
  function handleAuth(res) {
    if (res.status === 401) { loginRedirect(); return true; }
    return false;
  }

  /** @param {string} path @param {File} file @param {{ width: number, height: number } | null} dimensions */
  function populateImageObject(path, file, dimensions) {
    var parts = path.split(".");
    if (parts.length < 2 || parts[parts.length - 1] !== "src") return;
    var parentPath = parts.slice(0, -1).join(".");
    var current = getNestedValue(entryData, parentPath);
    if (!current || typeof current !== "object" || Array.isArray(current)) return;

    var next = /** @type {Record<string, unknown>} */ (deepClone(current));
    var title = friendlyFileTitle(file.name);
    if (Object.prototype.hasOwnProperty.call(next, "id") && !next.id) {
      next.id = generatedId(parentPath, Number(parts[parts.length - 2]) || 0);
    }
    if (Object.prototype.hasOwnProperty.call(next, "title") && !next.title) next.title = title;
    if (Object.prototype.hasOwnProperty.call(next, "alt") && !next.alt) next.alt = title;
    if (dimensions && Object.prototype.hasOwnProperty.call(next, "width")) next.width = dimensions.width;
    if (dimensions && Object.prototype.hasOwnProperty.call(next, "height")) next.height = dimensions.height;
    updateField(parentPath, next);

    ["id", "title", "alt", "width", "height"].forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) return;
      var control = document.getElementById(fieldIdFromPath(parentPath + "." + key));
      if (control && "value" in control) control.value = String(next[key]);
    });
  }

  /* ─── Save / Delete ─────────────────────────────────────────────── */
  function save() {
    if (!entryData || saving) return;
    if (SAVE_TARGET === "live") {
      var liveConfirmationKey = "caretcms:confirmed-live-save";
      var confirmed = false;
      try { confirmed = sessionStorage.getItem(liveConfirmationKey) === "1"; } catch (e) { /* storage may be disabled */ }
      if (!confirmed && !window.confirm(msg("entry.liveConfirm", "Save these changes directly to the live site?"))) return;
      try { sessionStorage.setItem(liveConfirmationKey, "1"); } catch (e) { /* confirmation still applies to this save */ }
    }
    saving = true;
    updateSaveButton();
    var preserveSaveStatus = false;
    /** @type {{ collection: string, id: string, data: Record<string, unknown>, expectedRevision?: number }} */
    var payload = {
      collection: COLLECTION,
      id: ID,
      data: entryData,
    };
    if (typeof entryRevision === "number") payload.expectedRevision = entryRevision;

    mutationClient.save(payload).then(function (result) {
      if (result.kind === "unauthorized") { loginRedirect(); return; }
      if (result.kind === "validation") {
          preserveSaveStatus = true;
          showValidationErrors(result.issues);
          showStatus("error", msg("entry.validationFailed", "Validation failed") + " (" + result.issues.length + ")");
          var firstErr = fieldsEl.querySelector(".studio-field-error");
          if (firstErr) firstErr.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
      }
      if (result.kind === "conflict") {
          preserveSaveStatus = true;
          // Your edits are still in the form; we've refreshed to the server's
          // revision, so saving again overwrites. Don't tell the user to reload
          // (that would throw their edits away).
          entryRevision = result.currentRevision;
          showStatus("error", msg("entry.changedElsewhere", "Changed elsewhere — Save again to overwrite"));
          return;
      }
      if (result.kind === "error") throw new Error("save failed");
      clearFieldErrors();
      if (typeof result.revision === "number") entryRevision = result.revision;
      originalJson = JSON.stringify(entryData);
      studioSync.announceChange("cms:saved", entryData);
      showStatus("saved", msg("entry.saved", "Saved"));
    }).catch(function () {
      preserveSaveStatus = true;
      showStatus("error", msg("common.error", "Error"));
    }).then(function () {
      saving = false;
      updateSaveButton(preserveSaveStatus);
    });
  }

  function deleteEntry() {
    deleteNameEl.textContent = ID;
    deleteRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : deleteBtn;
    deleteDialog.hidden = false;
    deleteCancelBtn.focus();
  }

  function closeDeleteDialog() {
    deleteDialog.hidden = true;
    var restore = deleteRestoreFocus || deleteBtn;
    deleteRestoreFocus = null;
    if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
  }

  function confirmDelete() {
    deleteConfirmBtn.disabled = true;
    deleteConfirmBtn.textContent = msg("entry.deleting", "Deleting…");
    /** @type {{ collection: string, id: string, expectedRevision?: number }} */
    var payload = { collection: COLLECTION, id: ID };
    if (typeof entryRevision === "number") payload.expectedRevision = entryRevision;
    mutationClient.remove(payload).then(function (result) {
      if (result === "unauthorized") { loginRedirect(); return; }
      if (result !== "deleted") throw new Error("delete failed");
      studioSync.announceChange("cms:deleted", null);
      window.location.href = MOUNT + "/cms/" + encodeURIComponent(COLLECTION);
    }).catch(function () {
      closeDeleteDialog();
      deleteConfirmBtn.disabled = false;
      deleteConfirmBtn.textContent = msg("entry.delete", "Delete");
      showStatus("error", msg("entry.deleteFailed", "Delete failed"));
    });
  }

  /* ─── Validation rendering ──────────────────────────────────────── */
  /** @param {Element} group @param {string} message */
  function showFieldError(group, message) {
    var errEl = group.querySelector(".studio-error-text");
    if (message) {
      if (!errEl) {
        errEl = document.createElement("p");
        errEl.className = "studio-error-text";
        group.appendChild(errEl);
      }
      errEl.textContent = message;
      /** @type {HTMLElement} */ (errEl).hidden = false;
      group.classList.add("studio-field-error");
    } else if (errEl) {
      errEl.remove();
      group.classList.remove("studio-field-error");
    }
  }

  function clearFieldErrors() {
    fieldsEl.querySelectorAll(".studio-error-text").forEach(function (el) { el.remove(); });
    fieldsEl.querySelectorAll(".caret-field-group").forEach(function (el) { el.classList.remove("studio-field-error"); });
  }

  /** @param {ValidationIssue[]} issues */
  function showValidationErrors(issues) {
    clearFieldErrors();
    issues.forEach(function (issue) {
      var group = fieldsEl.querySelector('[data-field-path="' + cssEscape(issue.path) + '"]');
      if (group) showFieldError(group, issue.message);
    });
  }

  /** @param {string} value */
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  /** @param {string} path */
  function fieldControl(path) {
    return fieldsEl.querySelector("#" + cssEscape(fieldIdFromPath(path)));
  }

  /** @param {Element} group */
  function showLinkedSelection(group) {
    window.clearTimeout(linkedSelectionTimer);
    fieldsEl.querySelectorAll(".caret-field-selected").forEach(function (selected) {
      selected.classList.remove("caret-field-selected");
    });
    group.classList.add("caret-field-selected");
    linkedSelectionTimer = window.setTimeout(function () {
      group.classList.remove("caret-field-selected");
    }, 1500);
  }

  /** @param {Record<string, unknown>} message */
  function applyRemoteSelection(message) {
    if (
      !message
      || message.collection !== COLLECTION
      || message.id !== ID
      || typeof message.field !== "string"
    ) return;

    if (!entryData) {
      pendingRemoteSelection = message;
      return;
    }

    var control = fieldControl(message.field);
    var group = control && control.closest(".caret-field-group");
    if (!group) return;
    showLinkedSelection(group);
    group.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  }

  /* ─── Field rendering ───────────────────────────────────────────── */

  const { renderFields, renderFieldsFallback } = createFieldRenderer({
    updateField,
    buildSingleImage,
    buildImageGallery,
    buildObjectArray,
    buildTagList,
    getPublicationField: () => publicationFieldName,
  });

  /* ─── Image gallery ─────────────────────────────────────────────── */
  /** @param {unknown} images @param {string} path */
  function buildImageGallery(images, path) {
    var wrapper = document.createElement("div");

    function rerender() {
      wrapper.innerHTML = "";
      var galleryValue = getNestedValue(entryData, path);
      var current = Array.isArray(galleryValue)
        ? galleryValue.filter(function (value) { return typeof value === "string"; })
        : [];

      if (current.length > 0) {
        var grid = document.createElement("div");
        grid.className = "caret-gallery-grid";
        /** @type {number | null} */
        var dragIdx = null;

        current.forEach(function (url, idx) {
          var item = document.createElement("div");
          item.className = "studio-gallery-item caret-gallery-cell";
          item.draggable = true;
          item.innerHTML =
            '<img src="' + url + '" alt="Image ' + (idx + 1) + '" loading="lazy" />' +
            '<button class="caret-gallery-remove" type="button" title="' + htmlEscape(msg("field.remove", "Remove")) + '">×</button>' +
            '<span class="caret-gallery-index">' + (idx + 1) + "</span>";
          item.querySelector(".caret-gallery-remove")?.addEventListener("click", function (e) {
            e.stopPropagation();
            var imgs = current.slice();
            imgs.splice(idx, 1);
            updateField(path, imgs);
            rerender();
          });
          item.addEventListener("dragstart", function () { dragIdx = idx; item.classList.add("dragging"); });
          item.addEventListener("dragend", function () { dragIdx = null; item.classList.remove("dragging"); });
          item.addEventListener("dragover", function (e) {
            e.preventDefault();
            if (dragIdx !== null && dragIdx !== idx) item.classList.add("drag-over-item");
          });
          item.addEventListener("dragleave", function () { item.classList.remove("drag-over-item"); });
          item.addEventListener("drop", function (e) {
            e.preventDefault();
            item.classList.remove("drag-over-item");
            if (dragIdx !== null && dragIdx !== idx) {
              var imgs = current.slice();
              var moved = imgs.splice(dragIdx, 1)[0];
              imgs.splice(idx, 0, moved);
              updateField(path, imgs);
              rerender();
            }
          });
          grid.appendChild(item);
        });
        wrapper.appendChild(grid);
      }

      var dropzone = document.createElement("div");
      dropzone.className = "studio-dropzone caret-dropzone";
      dropzone.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;color:var(--studio-text-dim);margin-bottom:0.75rem;">' +
        '<path stroke-linecap="round" stroke-linejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z"/>' +
        "</svg>" +
        '<p style="margin:0 0 0.25rem;font-size:0.75rem;color:var(--studio-text-muted);">Drop images here or click to browse</p>' +
        '<p style="margin:0;font-size:0.7rem;color:var(--studio-text-dim);">JPEG, PNG, WebP, AVIF — max 10 MB each</p>';

      var fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.multiple = true;
      fileInput.accept = "image/jpeg,image/png,image/webp,image/avif";
      fileInput.setAttribute("aria-label", "Upload images for " + humanizeKey(path.split(".").pop() || "images"));
      fileInput.style.display = "none";

      /** @param {ArrayLike<File>} files */
      function handleFiles(files) {
        var valid = Array.from(files).filter(function (f) {
          return isSupportedImage(f);
        });
        if (!valid.length) return;
        dropzone.innerHTML =
          '<div class="studio-spinner" style="margin-bottom:0.5rem;"></div>' +
          '<p style="margin:0;font-size:0.75rem;color:var(--studio-text-muted);">Uploading ' + valid.length + " image" + (valid.length > 1 ? "s" : "") + "…</p>";
        dropzone.style.pointerEvents = "none";

        var existingImages = getNestedValue(entryData, path);
        var imgs = Array.isArray(existingImages)
          ? existingImages.filter(function (value) { return typeof value === "string"; })
          : [];
        Promise.allSettled(valid.map(function (f) { return uploadClient.upload(f); })).then(function (results) {
          results.forEach(function (r) { if (r.status === "fulfilled") imgs.push(r.value); });
          updateField(path, imgs);
          rerender();
        });
      }

      dropzone.addEventListener("click", function () { fileInput.click(); });
      dropzone.addEventListener("dragover", function (e) { e.preventDefault(); dropzone.classList.add("drag-over"); });
      dropzone.addEventListener("dragleave", function () { dropzone.classList.remove("drag-over"); });
      dropzone.addEventListener("drop", function (e) {
        e.preventDefault();
        dropzone.classList.remove("drag-over");
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length) handleFiles(files);
      });
      fileInput.addEventListener("change", function () {
        if (fileInput.files && fileInput.files.length) handleFiles(fileInput.files);
        fileInput.value = "";
      });

      wrapper.appendChild(dropzone);
      wrapper.appendChild(fileInput);
    }

    rerender();
    return wrapper;
  }

  /* ─── Single image ──────────────────────────────────────────────── */
  /** @param {unknown} url @param {string} path */
  function buildSingleImage(url, path) {
    var wrapper = document.createElement("div");
    wrapper.className = "caret-single-image";

    function rerender() {
      wrapper.innerHTML = "";
      var imageValue = getNestedValue(entryData, path);
      var current = typeof imageValue === "string" ? imageValue : "";

      var fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/jpeg,image/png,image/webp,image/avif";
      fileInput.setAttribute("aria-label", msg("field.uploadOrReplaceImage", "Upload or replace image"));
      fileInput.style.display = "none";

      if (current) {
        var preview = document.createElement("button");
        preview.type = "button";
        preview.className = "caret-single-image-preview";
        preview.title = msg("field.replaceImage", "Replace image");
        preview.setAttribute("aria-label", msg("field.replaceImage", "Replace image"));
        var image = document.createElement("img");
        image.src = current;
        image.alt = "Current image preview";
        var overlay = document.createElement("span");
        overlay.className = "caret-single-image-overlay";
        overlay.textContent = msg("field.replaceImage", "Replace image");
        preview.appendChild(image);
        preview.appendChild(overlay);
        preview.addEventListener("click", function () { fileInput.click(); });
        wrapper.appendChild(preview);
      } else {
        var emptyPreview = document.createElement("button");
        emptyPreview.type = "button";
        emptyPreview.className = "caret-single-image-empty";
        emptyPreview.textContent = "+ Choose an image";
        emptyPreview.addEventListener("click", function () { fileInput.click(); });
        wrapper.appendChild(emptyPreview);
      }

      var row = document.createElement("div");
      row.className = "caret-single-image-row";

      var input = document.createElement("input");
      input.type = "text";
      input.className = "studio-input";
      input.id = fieldIdFromPath(path);
      input.name = path;
      input.style.flex = "1";
      input.value = current;
      input.placeholder = "Image URL";
      input.addEventListener("input", function () { updateField(path, input.value); });
      input.addEventListener("blur", rerender);

      var uploadBtn = document.createElement("button");
      uploadBtn.type = "button";
      uploadBtn.className = "studio-btn-ghost";
      uploadBtn.textContent = current ? "Replace" : "Upload";

      var help = document.createElement("p");
      help.className = "caret-image-help";
      help.textContent = current
        ? "Click the preview or Replace to upload a new image. You can also paste a URL. For gallery images, blank title and alt fields are filled from the filename—review them before saving."
        : "Upload an image or paste its URL.";

      uploadBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        var selectedFile = file;
        uploadBtn.textContent = "Uploading…";
        uploadBtn.disabled = true;
        Promise.all([uploadClient.upload(selectedFile), uploadClient.readDimensions(selectedFile)]).then(function (results) {
          updateField(path, results[0]);
          populateImageObject(path, selectedFile, results[1]);
          rerender();
        }).catch(function () {
          help.textContent = "Upload failed. Check the image type and try again.";
          help.classList.add("is-error");
          uploadBtn.textContent = current ? "Replace" : "Upload";
          uploadBtn.disabled = false;
        });
        fileInput.value = "";
      });

      row.appendChild(input);
      row.appendChild(uploadBtn);
      row.appendChild(fileInput);
      wrapper.appendChild(row);
      wrapper.appendChild(help);
    }

    rerender();
    return wrapper;
  }

  /* ─── Tag list ──────────────────────────────────────────────────── */
  /** @param {unknown} items @param {string} path */
  function buildTagList(items, path) {
    var wrapper = document.createElement("div");

    function rerender() {
      wrapper.innerHTML = "";
      var tagValue = getNestedValue(entryData, path);
      var current = Array.isArray(tagValue)
        ? tagValue.filter(function (value) { return typeof value === "string"; })
        : [];

      if (current.length > 0) {
        var tagsEl = document.createElement("div");
        tagsEl.className = "caret-tags";
        current.forEach(function (item, idx) {
          var tag = document.createElement("span");
          tag.className = "studio-tag";
          tag.textContent = item;
          var btn = document.createElement("button");
          btn.type = "button";
          btn.title = msg("field.remove", "Remove");
          btn.textContent = "×";
          btn.addEventListener("click", function () {
            var next = current.slice();
            next.splice(idx, 1);
            updateField(path, next);
            rerender();
          });
          tag.appendChild(btn);
          tagsEl.appendChild(tag);
        });
        wrapper.appendChild(tagsEl);
      }

      var row = document.createElement("div");
      row.className = "caret-add-row";
      var input = document.createElement("input");
      input.type = "text";
      input.className = "studio-input";
      input.style.flex = "1";
      input.placeholder = "Add item and press Enter";

      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "studio-btn-ghost";
      addBtn.textContent = "Add";

      function addTag() {
        var v = input.value.trim();
        if (v && current.indexOf(v) < 0) {
          updateField(path, current.concat([v]));
          rerender();
        }
      }

      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); addTag(); }
      });
      addBtn.addEventListener("click", addTag);
      row.appendChild(input);
      row.appendChild(addBtn);
      wrapper.appendChild(row);
    }

    rerender();
    return wrapper;
  }

  /* ─── Object array ──────────────────────────────────────────────── */
  /** @param {unknown} items @param {string} path @param {Schema | null | undefined} itemSchema */
  function buildObjectArray(items, path, itemSchema) {
    var wrapper = document.createElement("div");
    wrapper.className = "caret-object-array";
    /** @type {number | null} */
    var draggedIndex = null;

    /** @param {Record<string, unknown>} item @param {number} idx */
    function itemSummary(item, idx) {
      var summaryKeys = ["title", "label", "name", "alt", "src"];
      for (var i = 0; i < summaryKeys.length; i++) {
        var value = item && item[summaryKeys[i]];
        if (typeof value === "string" && value.trim()) {
          if (summaryKeys[i] === "src") {
            var clean = value.split("?")[0].split("/").pop();
            return clean || (singularItemLabel(path) + " " + (idx + 1));
          }
          return value;
        }
      }
      return singularItemLabel(path).replace(/^./, function (c) { return c.toUpperCase(); }) + " " + (idx + 1);
    }

    /** @param {Record<string, unknown>[]} current @param {number} from @param {number} to */
    function moveItem(current, from, to) {
      if (to < 0 || to >= current.length || from === to) return;
      var next = current.slice();
      var moved = next.splice(from, 1)[0];
      next.splice(to, 0, moved);
      updateField(path, next);
      rerender();
    }

    function rerender() {
      wrapper.innerHTML = "";
      var arrayValue = getNestedValue(entryData, path);
      var current = Array.isArray(arrayValue)
        ? arrayValue.filter(function (value) { return value !== null && typeof value === "object" && !Array.isArray(value); })
        : [];

      current.forEach(function (item, idx) {
        var card = document.createElement("div");
        card.className = "caret-object-array-item";

        var header = document.createElement("div");
        header.className = "caret-object-array-header";

        var dragHandle = document.createElement("button");
        dragHandle.type = "button";
        dragHandle.className = "caret-object-array-drag";
        dragHandle.draggable = true;
        dragHandle.title = msg("field.drag", "Drag to reorder");
        dragHandle.setAttribute("aria-label", msg("field.drag", "Drag to reorder") + " " + itemSummary(item, idx));
        dragHandle.textContent = "⠿";
        dragHandle.addEventListener("dragstart", function (event) {
          draggedIndex = idx;
          card.classList.add("caret-object-array-dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", String(idx));
          }
        });
        dragHandle.addEventListener("dragend", function () {
          draggedIndex = null;
          wrapper.querySelectorAll(".caret-object-array-item").forEach(function (row) {
            row.classList.remove("caret-object-array-dragging", "caret-object-array-drag-over");
          });
        });
        header.appendChild(dragHandle);

        var idxLabel = document.createElement("span");
        idxLabel.className = "caret-object-array-index";
        idxLabel.textContent = itemSummary(item, idx);
        header.appendChild(idxLabel);

        card.addEventListener("dragover", function (event) {
          if (draggedIndex === null || draggedIndex === idx) return;
          event.preventDefault();
          card.classList.add("caret-object-array-drag-over");
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        });
        card.addEventListener("dragleave", function () {
          card.classList.remove("caret-object-array-drag-over");
        });
        card.addEventListener("drop", function (event) {
          event.preventDefault();
          card.classList.remove("caret-object-array-drag-over");
          if (draggedIndex === null) return;
          var from = draggedIndex;
          draggedIndex = null;
          moveItem(current, from, idx);
        });

        var actions = document.createElement("div");
        actions.className = "caret-object-array-actions";

        var upBtn = document.createElement("button");
        upBtn.type = "button";
        upBtn.className = "caret-object-array-move";
        upBtn.title = msg("field.moveUp", "Move up");
        upBtn.setAttribute("aria-label", msg("field.moveUp", "Move up") + " " + itemSummary(item, idx));
        upBtn.textContent = "↑";
        upBtn.disabled = idx === 0;
        upBtn.addEventListener("click", function () { moveItem(current, idx, idx - 1); });

        var downBtn = document.createElement("button");
        downBtn.type = "button";
        downBtn.className = "caret-object-array-move";
        downBtn.title = msg("field.moveDown", "Move down");
        downBtn.setAttribute("aria-label", msg("field.moveDown", "Move down") + " " + itemSummary(item, idx));
        downBtn.textContent = "↓";
        downBtn.disabled = idx === current.length - 1;
        downBtn.addEventListener("click", function () { moveItem(current, idx, idx + 1); });

        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "caret-object-array-remove";
        removeBtn.title = msg("field.remove", "Remove") + " " + singularItemLabel(path);
        removeBtn.setAttribute("aria-label", msg("field.remove", "Remove") + " " + itemSummary(item, idx));
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", function () {
          var next = current.slice();
          next.splice(idx, 1);
          updateField(path, next);
          rerender();
        });

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
        actions.appendChild(removeBtn);
        header.appendChild(actions);
        card.appendChild(header);

        var fieldsCont = document.createElement("div");
        fieldsCont.className = "caret-object-array-fields";

        if (itemSchema && itemSchema.properties) {
          renderFields(fieldsCont, item, itemSchema, path + "." + idx);
        } else {
          renderFieldsFallback(fieldsCont, item, path + "." + idx);
        }

        card.appendChild(fieldsCont);
        wrapper.appendChild(card);
      });

      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "caret-object-array-add";
      addBtn.textContent = "+ " + msg("field.add", "Add") + " " + singularItemLabel(path);
      addBtn.addEventListener("click", function () {
        /** @type {Record<string, unknown>} */
        var template;
        if (itemSchema && itemSchema.properties) {
          var templateValue = templateFromSchema(itemSchema);
          template = templateValue && typeof templateValue === "object" && !Array.isArray(templateValue)
            ? /** @type {Record<string, unknown>} */ (templateValue)
            : {};
          if (Object.prototype.hasOwnProperty.call(template, "id") && !template.id) {
            template.id = generatedId(path, current.length);
          }
        } else {
          template = current.length > 0
            ? Object.fromEntries(Object.keys(current[0]).map(function (k) {
              var sample = current[0][k];
              return [k, typeof sample === "number" ? 0 : (typeof sample === "boolean" ? false : (Array.isArray(sample) ? [] : (sample && typeof sample === "object" ? {} : "")))];
            }))
            : {};
        }
        updateField(path, current.concat([template]));
        rerender();
        var cards = wrapper.querySelectorAll(".caret-object-array-item");
        var newest = cards[cards.length - 1];
        var firstControl = newest && newest.querySelector("input, textarea, select, button.caret-single-image-empty");
        // Focus immediately. Deferring focus to the next animation frame can
        // steal it back after a fast user (or assistive automation) has already
        // moved to another control in the new row.
        if (firstControl instanceof HTMLElement) firstControl.focus();
        requestAnimationFrame(function () {
          if (newest) newest.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      });
      wrapper.appendChild(addBtn);
    }

    rerender();
    return wrapper;
  }

  /* ─── History ───────────────────────────────────────────────────── */
  function loadHistory() {
    historyList.innerHTML = '<p style="font-size:0.75rem;color:var(--studio-text-dim);margin:0;">Loading…</p>';
    historyPanel.hidden = false;
    historyBtn.setAttribute("aria-expanded", "true");
    historyCloseBtn.focus();

    historyClient.list({ collection: COLLECTION, id: ID }).then(function (result) {
      if (result.kind === "unauthorized") { loginRedirect(); return; }
      if (result.kind === "error") throw new Error("history failed");
      var items = result.items;
      if (items.length === 0) {
        historyList.innerHTML = '<p style="font-size:0.75rem;color:var(--studio-text-dim);margin:0;">No history yet. Edits create snapshots automatically.</p>';
        return;
      }
      historyList.innerHTML = "";
      items.forEach(function (item) {
        var row = document.createElement("div");
        row.className = "caret-history-row";
        var date = new Date(item.ts);
        var timeStr = date.toLocaleString();

        var info = document.createElement("div");
        info.style.cssText = "display:flex;align-items:center;gap:0.75rem;";

        var actionSpan = document.createElement("span");
        actionSpan.className = "caret-history-action";
        actionSpan.dataset.action = item.action || "save";
        actionSpan.textContent = item.action || "save";

        var timeSpan = document.createElement("span");
        timeSpan.style.cssText = "font-size:0.75rem;color:var(--studio-text-muted);";
        timeSpan.textContent = timeStr;

        info.appendChild(actionSpan);
        info.appendChild(timeSpan);
        if (item.editor && typeof item.editor.id === "string") {
          var editorSpan = document.createElement("span");
          editorSpan.style.cssText = "font-size:0.7rem;color:var(--studio-text-dim);";
          editorSpan.textContent = item.editor.name || item.editor.email || item.editor.id;
          info.appendChild(editorSpan);
        }
        row.appendChild(info);

        var restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.className = "studio-btn-ghost";
        restoreBtn.textContent = "Restore";
        restoreBtn.addEventListener("click", function () { restoreSnapshot(item.ts); });
        row.appendChild(restoreBtn);

        historyList.appendChild(row);
      });
    }).catch(function () {
      historyList.innerHTML = '<p style="font-size:0.75rem;color:var(--studio-red);margin:0;">Failed to load history</p>';
    });
  }

  function closeHistoryPanel() {
    historyPanel.hidden = true;
    historyBtn.setAttribute("aria-expanded", "false");
    historyList.innerHTML = "";
    if (historyBtn.isConnected) historyBtn.focus();
  }

  /** @param {number} ts */
  function restoreSnapshot(ts) {
    if (!window.confirm("Restore this version? Current changes will be saved to history first.")) return;
    historyClient.restore({ collection: COLLECTION, id: ID, ts: ts }).then(function (result) {
      if (result.kind === "unauthorized") { loginRedirect(); return; }
      if (result.kind === "error") throw new Error("restore failed");
      var prevData = entryData;
      var prevJson = originalJson;
      try {
        if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
          throw new Error("invalid restored entry data");
        }
        entryData = deepClone(/** @type {Record<string, unknown>} */ (result.data));
        originalJson = JSON.stringify(result.data);
        if (typeof result.revision === "number") entryRevision = result.revision;
        fieldsEl.innerHTML = "";
        renderFields(fieldsEl, entryData, entrySchema, "");
        updateSaveButton();
      } catch (e) {
        entryData = prevData;
        originalJson = prevJson;
        fieldsEl.innerHTML = "";
        renderFields(fieldsEl, entryData, entrySchema, "");
        updateSaveButton();
        showStatus("error", "Restore failed — invalid data");
        return;
      }
      closeHistoryPanel();
      studioSync.announceChange("cms:saved", entryData);
      showStatus("saved", "Restored");
    }).catch(function () {
      showStatus("error", "Restore failed");
    });
  }

  /* ─── Wire events ───────────────────────────────────────────────── */
  saveBtn.addEventListener("click", save);
  if (deleteBtn) deleteBtn.addEventListener("click", deleteEntry);
  historyBtn.addEventListener("click", loadHistory);
  historyCloseBtn.addEventListener("click", closeHistoryPanel);
  deleteCancelBtn.addEventListener("click", closeDeleteDialog);
  deleteConfirmBtn.addEventListener("click", confirmDelete);
  deleteDialog.addEventListener("click", function (e) {
    if (e.target === deleteDialog) closeDeleteDialog();
  });
  deleteDialog.addEventListener("keydown", function (e) {
    if (deleteDialog.hidden) return;
    if (e.key !== "Tab") return;
    var controls = Array.from(deleteDialog.querySelectorAll("button:not([disabled])"));
    var first = controls[0];
    var last = controls[controls.length - 1];
    if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) return;
    var active = document.activeElement;
    if (e.shiftKey && (active === first || !deleteDialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Focusing a Studio control locates its live-page counterpart without
  // stealing focus from the editor. The temporary blue cue is distinct from
  // green save confirmation.
  fieldsEl.addEventListener("focusin", function (event) {
    var control = event.target instanceof Element
      ? event.target.closest("input, select, textarea, button")
      : null;
    var group = control && control.closest("[data-field-path]");
    var path = group instanceof HTMLElement ? group.dataset.fieldPath : undefined;
    if (!path) return;
    if (!group) return;
    showLinkedSelection(group);
    studioSync.announceFieldSelection(path);
  });

  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && (!deleteDialog.hidden || !historyPanel.hidden)) {
      e.preventDefault();
      e.stopPropagation();
      if (!deleteDialog.hidden) closeDeleteDialog();
      else closeHistoryPanel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (isDirty()) save();
    }
  }, true);

  window.addEventListener("beforeunload", function (e) {
    if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ─── Load entry + schema ───────────────────────────────────────── */
  entryLoader.load({
    collection: COLLECTION,
    id: ID,
    isNew: IS_NEW,
    initializeIfMissing: INITIALIZE_IF_MISSING,
  }).then(function (result) {
        if (result.kind === "unauthorized") { loginRedirect(); return; }
        if (result.kind === "error") {
          throw new Error(msg("entry." + result.code, msg("entry.loadFailed", "Could not load this entry. Retry after checking its source or storage.")));
        }
        entrySchema = result.schema;
        publicationFieldName = result.publicationFieldName;
        loadingEl.hidden = true;
        if (result.kind === "missing") {
          notFoundEl.hidden = false;
          return;
        }
        var initialData = result.data;
        entryData = deepClone(initialData);
        entryRevision = result.revision;
        originalJson = JSON.stringify(initialData);
        titleEl.textContent = getTitle(entryData);
        renderFields(fieldsEl, entryData, entrySchema, "");
        if (validationWarningEl && result.validationIssues.length > 0) {
          validationWarningEl.textContent = "This stored entry has invalid fields: " + result.validationIssues.map(function (issue) {
            return (issue.path || "entry") + " — " + issue.message;
          }).join("; ") + ". Correct them and Save to restore public delivery.";
          validationWarningEl.hidden = false;
        }
        updateSaveButton();
        if (IS_NEW || result.initialized) {
          var guideTitle = document.getElementById("editor-guide-title");
          var guideCopy = document.getElementById("editor-guide-copy");
          if (guideTitle) guideTitle.textContent = msg("entry.newGuideTitle", "Entry created with safe defaults");
          if (guideCopy) guideCopy.textContent = msg("entry.newGuideCopy", "Fill in the fields below. Save becomes available after your first change. In the sidebar Studio, text and image edits preview on the page as you work; Save confirms them and refreshes the visual preview for structural changes. When publication is enabled, new entries stay private until Published is turned on.");
        }
        editorEl.hidden = false;
        studioSync.announceReady();
        if (pendingRemoteSelection) {
          var pending = pendingRemoteSelection;
          pendingRemoteSelection = null;
          applyRemoteSelection(pending);
        }
  }).catch(function (error) {
    loadingEl.hidden = true;
    notFoundEl.hidden = true;
    /** @type {HTMLElement} */ (document.getElementById("load-error")).hidden = false;
    /** @type {HTMLElement} */ (document.getElementById("load-error-message")).textContent = error instanceof Error ? error.message : msg("entry.loadFailed", "Could not load this entry.");
  });
  /** @type {HTMLElement} */ (document.getElementById("load-error-retry")).addEventListener("click", function () { window.location.reload(); });
})();
