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

  var CFG;
  try {
    CFG = JSON.parse(configEl.textContent || "{}");
  } catch (e) {
    console.error("[caret] invalid entry config", e);
    return;
  }

  var API = CFG.apiBasePath;
  var MOUNT = CFG.mountPath;
  var COLLECTION = CFG.collection;
  var ID = CFG.id;
  var IS_NEW = CFG.isNew === true;
  var INITIALIZE_IF_MISSING = CFG.initializeIfMissing === true;
  var SAVE_TARGET = CFG.saveTarget === "preview" ? "preview" : "live";
  var MSG = CFG.messages || {};
  function msg(key, fallback) { return typeof MSG[key] === "string" ? MSG[key] : fallback; }
  function htmlEscape(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }
  if (!API || !COLLECTION || !ID) return;

  /* ─── State ─────────────────────────────────────────────────────── */
  var entryData = null;
  var entrySchema = null;
  var entryRevision = undefined;
  var originalJson = "";
  var saving = false;
  var dirtyTimer = 0;
  var previewTimer = 0;
  var linkedSelectionTimer = 0;
  var pendingRemoteSelection = null;
  var SYNC_CHANNEL = "caretcms:content";
  var syncChannel = null;

  /* ─── DOM refs ──────────────────────────────────────────────────── */
  var loadingEl = document.getElementById("loading");
  var notFoundEl = document.getElementById("not-found");
  var editorEl = document.getElementById("editor");
  var fieldsEl = document.getElementById("fields");
  var titleEl = document.getElementById("entry-title");
  var statusEl = document.getElementById("status-msg");
  var validationWarningEl = document.getElementById("validation-warning");
  var saveBtn = document.getElementById("btn-save");
  var deleteBtn = document.getElementById("btn-delete");
  var historyBtn = document.getElementById("btn-history");
  var historyPanel = document.getElementById("history-panel");
  var historyList = document.getElementById("history-list");
  var historyCloseBtn = document.getElementById("btn-history-close");
  var deleteDialog = document.getElementById("delete-dialog");
  var deleteNameEl = document.getElementById("delete-entry-name");
  var deleteCancelBtn = document.getElementById("btn-delete-cancel");
  var deleteConfirmBtn = document.getElementById("btn-delete-confirm");

  /* ─── Helpers ───────────────────────────────────────────────────── */
  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

  function templateFromSchema(schema) {
    if (!schema || typeof schema !== "object") return "";
    if (schema.default !== undefined) return deepClone(schema.default);
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return deepClone(schema.enum[0]);
    if (schema.type === "object") {
      var objectTemplate = {};
      Object.keys(schema.properties || {}).forEach(function (key) {
        objectTemplate[key] = templateFromSchema(schema.properties[key]);
      });
      return objectTemplate;
    }
    if (schema.type === "array") return [];
    if (schema.type === "boolean") return false;
    if (schema.type === "number" || schema.type === "integer") {
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    }
    return "";
  }

  function generatedId(path, index) {
    var parts = path.split(".").filter(Boolean);
    var key = parts.pop() || "item";
    if (/^\d+$/.test(key)) key = parts.pop() || "item";
    key = key.replace(/ies$/, "y").replace(/s$/, "");
    return (key + "-" + (index + 1) + "-" + Date.now().toString(36))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function friendlyFileTitle(filename) {
    return String(filename || "Image")
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || "Image";
  }

  function singularItemLabel(path) {
    var key = (path.split(".").filter(Boolean).pop() || "item").toLowerCase();
    if (key === "images") return "image";
    if (key === "details") return "detail";
    if (key === "documents") return "document";
    if (key === "videos") return "video";
    if (key === "links") return "link";
    if (key === "resume") return "résumé item";
    return key.replace(/ies$/, "y").replace(/s$/, "") || "item";
  }

  function getTitle(data) {
    if (!data) return "Untitled";
    var keys = ["name", "title", "question", "company_name", "headline", "label"];
    for (var i = 0; i < keys.length; i++) {
      if (typeof data[keys[i]] === "string" && data[keys[i]]) return data[keys[i]];
    }
    return "Untitled";
  }

  function humanizeKey(key) {
    return key.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function isDirty() {
    return entryData !== null && JSON.stringify(entryData) !== originalJson;
  }

  function updateSaveButton() {
    var dirty = isDirty();
    saveBtn.disabled = !dirty || saving;
    saveBtn.classList.remove("studio-save-dirty", "studio-save-clean", "studio-save-saving");
    saveBtn.classList.add(saving ? "studio-save-saving" : (dirty ? "studio-save-dirty" : "studio-save-clean"));
    saveBtn.textContent = saving ? msg("common.saving", "Saving…") : (SAVE_TARGET === "preview" ? msg("entry.saveDraft", "Save draft") : msg("entry.saveLive", "Save live"));
    titleEl.textContent = getTitle(entryData);
    if (entryData !== null) {
      if (saving) showStatus("saving", msg("entry.savingChanges", "Saving changes…"));
      else if (dirty) showStatus("dirty", msg("entry.unsaved", "Unsaved changes"));
      else showStatus("saved", msg("entry.allSaved", "All changes saved"));
    }
  }

  function showStatus(type, msg) {
    statusEl.textContent = msg;
    statusEl.hidden = false;
    statusEl.dataset.status = type;
    statusEl.style.color = type === "saved"
      ? "var(--studio-green)"
      : (type === "dirty" || type === "saving" ? "var(--studio-text-muted)" : "var(--studio-red)");
  }

  function setNestedValue(obj, path, value) {
    var keys = path.split(".");
    var cur = obj;
    for (var i = 0; i < keys.length - 1; i++) {
      var k = keys[i];
      if (typeof cur[k] !== "object" || cur[k] === null) {
        cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      }
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
  }

  function getNestedValue(obj, path) {
    return path.split(".").reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }

  function updateField(path, value) {
    setNestedValue(entryData, path, value);
    if (!saving) {
      saveBtn.disabled = false;
      saveBtn.classList.remove("studio-save-clean", "studio-save-saving");
      saveBtn.classList.add("studio-save-dirty");
    }
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(updateSaveButton, 300);
    queueEmbeddedPreview();
  }

  function loginRedirect() {
    window.location.href = MOUNT + "?redirect=" + encodeURIComponent(window.location.pathname);
  }

  function handleAuth(res) {
    if (res.status === 401) { loginRedirect(); return true; }
    return false;
  }

  function queueEmbeddedPreview() {
    if (window.parent === window || !entryData) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      try {
        window.parent.postMessage({
          type: "cms:preview",
          collection: COLLECTION,
          id: ID,
          data: deepClone(entryData),
          embedded: true,
          studioPath: window.location.pathname + window.location.search,
        }, window.location.origin);
      } catch (e) { /* visual preview is a progressive enhancement */ }
    }, 80);
  }

  function announceChange(type, data) {
    var message = {
      type: type,
      collection: COLLECTION,
      id: ID,
      data: data ? deepClone(data) : null,
      embedded: window.parent !== window,
      studioPath: window.location.pathname + window.location.search,
      savedAt: Date.now(),
    };

    if (window.parent !== window) {
      try { window.parent.postMessage(message, window.location.origin); } catch (e) { /* noop */ }
    }

    if ("BroadcastChannel" in window) {
      try {
        var channel = new BroadcastChannel(SYNC_CHANNEL);
        channel.postMessage(message);
        setTimeout(function () { channel.close(); }, 0);
      } catch (e) { /* automatic preview sync is a progressive enhancement */ }
    }
  }

  /* ─── Image compression + upload ────────────────────────────────── */
  function compressImage(file, maxWidth, quality) {
    maxWidth = maxWidth || 1600;
    quality = quality || 0.82;
    return Promise.resolve().then(function () {
      if (file.size < 200000 && file.type === "image/webp") return file;
      return createImageBitmap(file).then(function (bitmap) {
        var width = bitmap.width;
        var height = bitmap.height;
        var needsResize = width > maxWidth;
        if (file.type === "image/png" && !needsResize) {
          bitmap.close();
          return file;
        }
        if (needsResize) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        var isPng = file.type === "image/png";
        var outType = isPng ? "image/png" : "image/webp";
        return new Promise(function (resolve) {
          canvas.toBlob(function (blob) {
            if (!blob || blob.size >= file.size) return resolve(file);
            var ext = isPng ? ".png" : ".webp";
            resolve(new File([blob], file.name.replace(/\.[^.]+$/, ext), { type: outType }));
          }, outType, isPng ? undefined : quality);
        });
      });
    });
  }

  function uploadFile(file) {
    return compressImage(file).then(function (compressed) {
      var fd = new FormData();
      fd.append("file", compressed);
      return fetch(API + "/upload", {
        method: "POST",
        body: fd,
        headers: { "x-caret-request": "1" },
        credentials: "same-origin",
      });
    }).then(function (res) {
      if (handleAuth(res)) throw new Error("Unauthorized");
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    }).then(function (json) { return json.url; });
  }

  function readImageDimensions(file) {
    return createImageBitmap(file).then(function (bitmap) {
      var width = bitmap.width;
      var height = bitmap.height;
      bitmap.close();
      if (width > 1600) {
        height = Math.round((height * 1600) / width);
        width = 1600;
      }
      return { width: width, height: height };
    }).catch(function () { return null; });
  }

  function populateImageObject(path, file, dimensions) {
    var parts = path.split(".");
    if (parts.length < 2 || parts[parts.length - 1] !== "src") return;
    var parentPath = parts.slice(0, -1).join(".");
    var current = getNestedValue(entryData, parentPath);
    if (!current || typeof current !== "object" || Array.isArray(current)) return;

    var next = deepClone(current);
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
    var payload = {
      type: "put_entry",
      collection: COLLECTION,
      id: ID,
      data: entryData,
    };
    if (typeof entryRevision === "number") payload.expectedRevision = entryRevision;

    fetch(API + "/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-caret-request": "1" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (handleAuth(res)) return null;
      return res.json().catch(function () { return null; }).then(function (body) {
        return { ok: res.ok, status: res.status, body: body };
      });
    }).then(function (result) {
      if (!result) return;
      if (!result.ok) {
        if (result.body && result.body.issues) {
          showValidationErrors(result.body.issues);
          showStatus("error", msg("entry.validationFailed", "Validation failed") + " (" + result.body.issues.length + ")");
          var firstErr = fieldsEl.querySelector(".studio-field-error");
          if (firstErr) firstErr.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        if (result.status === 409 && result.body && typeof result.body.currentRevision === "number") {
          // Your edits are still in the form; we've refreshed to the server's
          // revision, so saving again overwrites. Don't tell the user to reload
          // (that would throw their edits away).
          entryRevision = result.body.currentRevision;
          showStatus("error", msg("entry.changedElsewhere", "Changed elsewhere — Save again to overwrite"));
          return;
        }
        throw new Error("save failed");
      }
      clearFieldErrors();
      if (result.body && typeof result.body.revision === "number") entryRevision = result.body.revision;
      originalJson = JSON.stringify(entryData);
      announceChange("cms:saved", entryData);
      showStatus("saved", msg("entry.saved", "Saved"));
    }).catch(function () {
      showStatus("error", msg("common.error", "Error"));
    }).then(function () {
      saving = false;
      updateSaveButton();
    });
  }

  function deleteEntry() {
    deleteNameEl.textContent = ID;
    deleteDialog.hidden = false;
  }

  function confirmDelete() {
    deleteConfirmBtn.disabled = true;
    deleteConfirmBtn.textContent = msg("entry.deleting", "Deleting…");
    var payload = { type: "delete_entry", collection: COLLECTION, id: ID };
    if (typeof entryRevision === "number") payload.expectedRevision = entryRevision;
    fetch(API + "/mutate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-caret-request": "1" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (handleAuth(res)) return;
      if (!res.ok) throw new Error("delete failed");
      announceChange("cms:deleted", null);
      window.location.href = MOUNT + "/cms/" + encodeURIComponent(COLLECTION);
    }).catch(function () {
      deleteDialog.hidden = true;
      deleteConfirmBtn.disabled = false;
      deleteConfirmBtn.textContent = msg("entry.delete", "Delete");
      showStatus("error", msg("entry.deleteFailed", "Delete failed"));
    });
  }

  /* ─── Validation rendering ──────────────────────────────────────── */
  function showFieldError(group, message) {
    var errEl = group.querySelector(".studio-error-text");
    if (message) {
      if (!errEl) {
        errEl = document.createElement("p");
        errEl.className = "studio-error-text";
        group.appendChild(errEl);
      }
      errEl.textContent = message;
      errEl.hidden = false;
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

  function showValidationErrors(issues) {
    clearFieldErrors();
    issues.forEach(function (issue) {
      var group = fieldsEl.querySelector('[data-field-path="' + cssEscape(issue.path) + '"]');
      if (group) showFieldError(group, issue.message);
    });
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function fieldControl(path) {
    return fieldsEl.querySelector("#" + cssEscape(fieldIdFromPath(path)));
  }

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

  function announceFieldSelection(path) {
    var message = {
      type: "cms:field-selected",
      collection: COLLECTION,
      id: ID,
      field: path,
      source: "studio",
    };

    if (window.parent !== window) {
      try {
        window.parent.postMessage(Object.assign({ embedded: true }, message), window.location.origin);
      } catch (e) { /* embedded selection linking is a progressive enhancement */ }
      return;
    }

    try {
      if (syncChannel) syncChannel.postMessage(message);
    } catch (e) { /* cross-tab selection linking is a progressive enhancement */ }
  }

  /* ─── Field group ───────────────────────────────────────────────── */
  function fieldIdFromPath(path) {
    return "caret-field-" + String(path || "").replace(/[^a-zA-Z0-9_-]/g, "-");
  }

  function createFieldGroup(label, isRequired, inline) {
    var wrapper = document.createElement("div");
    wrapper.className = "caret-field-group" + (inline ? " caret-field-inline" : "");

    var labelEl = document.createElement("label");
    labelEl.className = "studio-label";
    labelEl.textContent = label;
    if (isRequired === false) {
      var opt = document.createElement("span");
      opt.textContent = " (optional)";
      opt.style.cssText = "color:var(--studio-text-dim);font-weight:400;text-transform:none;letter-spacing:normal;";
      labelEl.appendChild(opt);
    }
    wrapper.appendChild(labelEl);

    // Once children are populated, link the label to the first form control
    // for screen-reader accessibility. Path is read from data-fieldPath
    // (set by the caller after createFieldGroup returns).
    queueMicrotask(function () {
      var path = wrapper.dataset.fieldPath;
      if (!path) return;
      // Nested object/array groups contain other field groups. Only claim a
      // control whose nearest field-group owner is this wrapper; otherwise an
      // outer `hero` group can overwrite `hero.headline`'s stable identity.
      var control = Array.from(wrapper.querySelectorAll("input, select, textarea")).find(function (candidate) {
        return candidate.closest(".caret-field-group") === wrapper;
      });
      if (!control) return;
      var fid = fieldIdFromPath(path);
      control.id = fid;
      control.name = path;
      labelEl.htmlFor = control.id;
    });

    return wrapper;
  }

  /* ─── Schema-driven rendering ───────────────────────────────────── */
  function renderFields(container, data, schema, basePath) {
    if (!schema || !schema.properties) {
      renderFieldsFallback(container, data, basePath);
      return;
    }

    var required = new Set(schema.required || []);

    Object.keys(schema.properties).forEach(function (key) {
      var prop = schema.properties[key];
      var path = basePath ? basePath + "." + key : key;
      var label = prop.title || humanizeKey(key);
      var isRequired = required.has(key);
      var value = data ? data[key] : undefined;

      // Backfill missing keys with sensible defaults
      if (value === undefined && data) {
        data[key] = templateFromSchema(prop);
      }
      var current = data ? data[key] : undefined;

      var group;

      if (prop.type === "string" && prop.enum) {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var select = document.createElement("select");
        select.className = "studio-input";
        prop.enum.forEach(function (opt) {
          var option = document.createElement("option");
          option.value = opt;
          option.textContent = String(opt).charAt(0).toUpperCase() + String(opt).slice(1);
          if (opt === current) option.selected = true;
          select.appendChild(option);
        });
        select.addEventListener("change", function () { updateField(path, select.value); });
        group.appendChild(select);
      } else if (prop.type === "string" && prop.format === "image") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        group.appendChild(buildSingleImage(current || "", path));
      } else if (prop.type === "string" && (prop.format === "textarea" || prop.format === "html")) {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var ta = document.createElement("textarea");
        ta.className = "studio-input";
        ta.rows = 4;
        ta.value = current || "";
        ta.addEventListener("input", function () { updateField(path, ta.value); });
        group.appendChild(ta);
      } else if (prop.type === "string" && (prop.format === "email" || prop.format === "uri" || prop.format === "url")) {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var emailInput = document.createElement("input");
        emailInput.type = prop.format === "email" ? "email" : "url";
        emailInput.className = "studio-input";
        emailInput.value = current || "";
        emailInput.addEventListener("input", function () { updateField(path, emailInput.value); });
        group.appendChild(emailInput);
      } else if (prop.type === "string") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var input;
        if (typeof current === "string" && current.length > 100) {
          input = document.createElement("textarea");
          input.rows = 4;
        } else {
          input = document.createElement("input");
          input.type = "text";
        }
        input.className = "studio-input";
        input.value = current || "";
        input.addEventListener("input", function () { updateField(path, input.value); });
        group.appendChild(input);
      } else if (prop.type === "number" || prop.type === "integer") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var num = document.createElement("input");
        num.type = "number";
        num.className = "studio-input";
        num.value = (current == null ? 0 : current);
        if (prop.minimum !== undefined) num.min = prop.minimum;
        if (prop.maximum !== undefined) num.max = prop.maximum;
        num.addEventListener("input", function () { updateField(path, Number(num.value) || 0); });
        group.appendChild(num);
      } else if (prop.type === "boolean") {
        group = createFieldGroup(label, isRequired, true);
        group.dataset.fieldPath = path;
        var toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "studio-toggle" + (current ? " active" : "");
        toggle.addEventListener("click", function () {
          var next = !toggle.classList.contains("active");
          toggle.classList.toggle("active");
          updateField(path, next);
        });
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-label", label);
        toggle.setAttribute("aria-checked", current ? "true" : "false");
        toggle.addEventListener("click", function () {
          toggle.setAttribute("aria-checked", toggle.classList.contains("active") ? "true" : "false");
        });
        group.appendChild(toggle);
        if (key === "published") {
          group.classList.add("caret-field-with-help");
          var publishHelp = document.createElement("p");
          publishHelp.className = "caret-field-help";
          publishHelp.textContent = "Turn this on and Save when the entry is ready to appear on the live site.";
          group.appendChild(publishHelp);
        }
      } else if (prop.type === "array" && prop.format === "image-gallery") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        group.appendChild(buildImageGallery(current || [], path));
      } else if (prop.type === "array" && prop.items && prop.items.type === "object") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        group.appendChild(buildObjectArray(current || [], path, prop.items));
      } else if (prop.type === "array" && prop.items && prop.items.type === "string") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        group.appendChild(buildTagList(current || [], path));
      } else if (prop.type === "object" && prop.properties) {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var nested = document.createElement("div");
        nested.className = "caret-nested";
        renderFields(nested, current || {}, prop, path);
        group.appendChild(nested);
      } else {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var jsonTa = document.createElement("textarea");
        jsonTa.className = "studio-input";
        jsonTa.style.fontFamily = "var(--studio-font-mono)";
        jsonTa.style.fontSize = "11px";
        jsonTa.rows = 4;
        jsonTa.value = JSON.stringify(current, null, 2);
        jsonTa.addEventListener("input", function () {
          try { updateField(path, JSON.parse(jsonTa.value)); } catch (e) { /* ignore until valid */ }
        });
        group.appendChild(jsonTa);
      }

      container.appendChild(group);
    });
  }

  function renderFieldsFallback(container, data, basePath) {
    if (!data || typeof data !== "object") return;
    Object.keys(data).forEach(function (key) {
      var value = data[key];
      var path = basePath ? basePath + "." + key : key;
      var label = humanizeKey(key);

      if (key === "images" && Array.isArray(value) && value.every(function (v) { return typeof v === "string"; })) {
        var g = createFieldGroup(label, true);
        g.dataset.fieldPath = path;
        g.appendChild(buildImageGallery(value, path));
        container.appendChild(g);
        return;
      }
      if ((key === "image" || key === "thumbnail" || key === "bg_image") && typeof value === "string") {
        var g2 = createFieldGroup(label, true);
        g2.dataset.fieldPath = path;
        g2.appendChild(buildSingleImage(value, path));
        container.appendChild(g2);
        return;
      }
      if (Array.isArray(value) && value.every(function (v) { return typeof v === "string"; })) {
        var g3 = createFieldGroup(label, true);
        g3.dataset.fieldPath = path;
        g3.appendChild(buildTagList(value, path));
        container.appendChild(g3);
        return;
      }
      if (Array.isArray(value) && value.every(function (v) { return typeof v === "object" && v !== null && !Array.isArray(v); })) {
        var g4 = createFieldGroup(label, true);
        g4.dataset.fieldPath = path;
        g4.appendChild(buildObjectArray(value, path, null));
        container.appendChild(g4);
        return;
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        var g5 = createFieldGroup(label, true);
        g5.dataset.fieldPath = path;
        var nested = document.createElement("div");
        nested.className = "caret-nested";
        renderFieldsFallback(nested, value, path);
        g5.appendChild(nested);
        container.appendChild(g5);
        return;
      }
      if (typeof value === "boolean") {
        var g6 = createFieldGroup(label, true, true);
        g6.dataset.fieldPath = path;
        var t = document.createElement("button");
        t.type = "button";
        t.className = "studio-toggle" + (value ? " active" : "");
        t.addEventListener("click", function () {
          var next = !t.classList.contains("active");
          t.classList.toggle("active");
          updateField(path, next);
        });
        g6.appendChild(t);
        container.appendChild(g6);
        return;
      }
      if (typeof value === "number") {
        var g7 = createFieldGroup(label, true);
        g7.dataset.fieldPath = path;
        var n = document.createElement("input");
        n.type = "number";
        n.className = "studio-input";
        n.value = value;
        n.addEventListener("input", function () { updateField(path, Number(n.value) || 0); });
        g7.appendChild(n);
        container.appendChild(g7);
        return;
      }
      if (typeof value === "string") {
        var g8 = createFieldGroup(label, true);
        g8.dataset.fieldPath = path;
        var i;
        if (value.length > 100) { i = document.createElement("textarea"); i.rows = 4; }
        else { i = document.createElement("input"); i.type = "text"; }
        i.className = "studio-input";
        i.value = value;
        i.addEventListener("input", function () { updateField(path, i.value); });
        g8.appendChild(i);
        container.appendChild(g8);
        return;
      }
      // Fallback to JSON
      var g9 = createFieldGroup(label, true);
      g9.dataset.fieldPath = path;
      var jt = document.createElement("textarea");
      jt.className = "studio-input";
      jt.style.fontFamily = "var(--studio-font-mono)";
      jt.style.fontSize = "11px";
      jt.rows = 4;
      jt.value = JSON.stringify(value, null, 2);
      jt.addEventListener("input", function () {
        try { updateField(path, JSON.parse(jt.value)); } catch (e) { /* ignore */ }
      });
      g9.appendChild(jt);
      container.appendChild(g9);
    });
  }

  /* ─── Image gallery ─────────────────────────────────────────────── */
  function buildImageGallery(images, path) {
    var wrapper = document.createElement("div");

    function rerender() {
      wrapper.innerHTML = "";
      var current = getNestedValue(entryData, path) || [];

      if (current.length > 0) {
        var grid = document.createElement("div");
        grid.className = "caret-gallery-grid";
        var dragIdx = null;

        current.forEach(function (url, idx) {
          var item = document.createElement("div");
          item.className = "studio-gallery-item caret-gallery-cell";
          item.draggable = true;
          item.innerHTML =
            '<img src="' + url + '" alt="Image ' + (idx + 1) + '" loading="lazy" />' +
            '<button class="caret-gallery-remove" type="button" title="' + htmlEscape(msg("field.remove", "Remove")) + '">×</button>' +
            '<span class="caret-gallery-index">' + (idx + 1) + "</span>";
          item.querySelector(".caret-gallery-remove").addEventListener("click", function (e) {
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

      function handleFiles(files) {
        var valid = Array.prototype.filter.call(files, function (f) {
          return ["image/jpeg", "image/png", "image/webp", "image/avif"].indexOf(f.type) >= 0;
        });
        if (!valid.length) return;
        dropzone.innerHTML =
          '<div class="studio-spinner" style="margin-bottom:0.5rem;"></div>' +
          '<p style="margin:0;font-size:0.75rem;color:var(--studio-text-muted);">Uploading ' + valid.length + " image" + (valid.length > 1 ? "s" : "") + "…</p>";
        dropzone.style.pointerEvents = "none";

        var imgs = (getNestedValue(entryData, path) || []).slice();
        Promise.allSettled(valid.map(function (f) { return uploadFile(f); })).then(function (results) {
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
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
      });
      fileInput.addEventListener("change", function () {
        if (fileInput.files.length) handleFiles(fileInput.files);
        fileInput.value = "";
      });

      wrapper.appendChild(dropzone);
      wrapper.appendChild(fileInput);
    }

    rerender();
    return wrapper;
  }

  /* ─── Single image ──────────────────────────────────────────────── */
  function buildSingleImage(url, path) {
    var wrapper = document.createElement("div");
    wrapper.className = "caret-single-image";

    function rerender() {
      wrapper.innerHTML = "";
      var current = getNestedValue(entryData, path) || "";

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
        uploadBtn.textContent = "Uploading…";
        uploadBtn.disabled = true;
        Promise.all([uploadFile(file), readImageDimensions(file)]).then(function (results) {
          updateField(path, results[0]);
          populateImageObject(path, file, results[1]);
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
  function buildTagList(items, path) {
    var wrapper = document.createElement("div");

    function rerender() {
      wrapper.innerHTML = "";
      var current = getNestedValue(entryData, path) || [];

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
  function buildObjectArray(items, path, itemSchema) {
    var wrapper = document.createElement("div");
    wrapper.className = "caret-object-array";
    var draggedIndex = null;

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
      var current = getNestedValue(entryData, path) || [];

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
        var template;
        if (itemSchema && itemSchema.properties) {
          template = templateFromSchema(itemSchema);
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
        if (firstControl) firstControl.focus();
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

    fetch(API + "/history?collection=" + encodeURIComponent(COLLECTION) + "&id=" + encodeURIComponent(ID), {
      credentials: "same-origin",
    }).then(function (res) {
      if (handleAuth(res)) return null;
      if (!res.ok) throw new Error("history failed");
      return res.json();
    }).then(function (json) {
      if (!json) return;
      var items = json.history || [];
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

  function restoreSnapshot(ts) {
    if (!window.confirm("Restore this version? Current changes will be saved to history first.")) return;
    fetch(API + "/history", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-caret-request": "1" },
      credentials: "same-origin",
      body: JSON.stringify({ collection: COLLECTION, id: ID, ts: ts }),
    }).then(function (res) {
      if (handleAuth(res)) return null;
      if (!res.ok) throw new Error("restore failed");
      return res.json();
    }).then(function (json) {
      if (!json) return;
      var prevData = entryData;
      var prevJson = originalJson;
      try {
        entryData = deepClone(json.data);
        originalJson = JSON.stringify(json.data);
        if (typeof json.revision === "number") entryRevision = json.revision;
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
      historyPanel.hidden = true;
      announceChange("cms:saved", entryData);
      showStatus("saved", "Restored");
    }).catch(function () {
      showStatus("error", "Restore failed");
    });
  }

  /* ─── Wire events ───────────────────────────────────────────────── */
  saveBtn.addEventListener("click", save);
  if (deleteBtn) deleteBtn.addEventListener("click", deleteEntry);
  historyBtn.addEventListener("click", loadHistory);
  historyCloseBtn.addEventListener("click", function () {
    historyPanel.hidden = true;
    historyList.innerHTML = "";
  });
  deleteCancelBtn.addEventListener("click", function () { deleteDialog.hidden = true; });
  deleteConfirmBtn.addEventListener("click", confirmDelete);
  deleteDialog.addEventListener("click", function (e) {
    if (e.target === deleteDialog) deleteDialog.hidden = true;
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === "cms:field-selected") {
      applyRemoteSelection(event.data);
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
    var path = group && group.dataset.fieldPath;
    if (!path) return;
    showLinkedSelection(group);
    announceFieldSelection(path);
  });

  if ("BroadcastChannel" in window) {
    try {
      syncChannel = new BroadcastChannel(SYNC_CHANNEL);
      syncChannel.addEventListener("message", function (event) {
        if (event.data && event.data.type === "cms:field-selected") {
          applyRemoteSelection(event.data);
        }
      });
      window.addEventListener("pagehide", function () { syncChannel.close(); }, { once: true });
    } catch (e) {
      syncChannel = null;
    }
  }

  window.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      if (isDirty()) save();
    }
    if (e.key === "Escape") {
      if (!deleteDialog.hidden) deleteDialog.hidden = true;
      if (!historyPanel.hidden) {
        historyPanel.hidden = true;
        historyList.innerHTML = "";
      }
    }
  });

  window.addEventListener("beforeunload", function (e) {
    if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ─── Load entry + schema ───────────────────────────────────────── */
  Promise.all([
    fetch(API + "/entries?collection=" + encodeURIComponent(COLLECTION) + "&id=" + encodeURIComponent(ID), { credentials: "same-origin" }),
    fetch(API + "/schema?collection=" + encodeURIComponent(COLLECTION), { credentials: "same-origin" }),
  ]).then(function (results) {
    var entryRes = results[0];
    var schemaRes = results[1];

    if (handleAuth(entryRes)) return;
    if (!entryRes.ok) throw new Error("load failed");

    return entryRes.json().then(function (entryJson) {
      var entry = (entryJson && entryJson.entries) ? entryJson.entries[0] : null;

      var schemaPromise = schemaRes.ok ? schemaRes.json() : Promise.resolve(null);
      return schemaPromise.then(function (schemaJson) {
        if (schemaJson && schemaJson.schema) entrySchema = schemaJson.schema;

        loadingEl.hidden = true;
        var initializedMissingEntry = !entry && (IS_NEW || INITIALIZE_IF_MISSING);
        if (!entry && !initializedMissingEntry) {
          notFoundEl.hidden = false;
          return;
        }
        var initialData = entry
          ? entry.data
          : (schemaJson && schemaJson.template) || templateFromSchema(entrySchema);
        entryData = deepClone(initialData);
        entryRevision = entry && typeof entry.revision === "number" ? entry.revision : 0;
        originalJson = JSON.stringify(initialData);
        titleEl.textContent = getTitle(entryData);
        renderFields(fieldsEl, entryData, entrySchema, "");
        if (validationWarningEl && entry && Array.isArray(entry.validationIssues) && entry.validationIssues.length > 0) {
          validationWarningEl.textContent = "This stored entry has invalid fields: " + entry.validationIssues.map(function (issue) {
            return (issue.path || "entry") + " — " + issue.message;
          }).join("; ") + ". Correct them and Save to restore public delivery.";
          validationWarningEl.hidden = false;
        }
        updateSaveButton();
        if (IS_NEW || initializedMissingEntry) {
          var guideTitle = document.getElementById("editor-guide-title");
          var guideCopy = document.getElementById("editor-guide-copy");
          if (guideTitle) guideTitle.textContent = msg("entry.newGuideTitle", "Entry created with safe defaults");
          if (guideCopy) guideCopy.textContent = msg("entry.newGuideCopy", "Fill in the fields below. Save becomes available after your first change. In the sidebar Studio, text and image edits preview on the page as you work; Save confirms them and refreshes the visual preview for structural changes. The Published switch controls whether signed-out visitors can see this entry.");
        }
        editorEl.hidden = false;
        if (window.parent !== window) {
          try {
            window.parent.postMessage({
              type: "cms:entry-ready",
              collection: COLLECTION,
              id: ID,
              embedded: true,
            }, window.location.origin);
          } catch (e) { /* embedded field linking is a progressive enhancement */ }
        }
        if (pendingRemoteSelection) {
          var pending = pendingRemoteSelection;
          pendingRemoteSelection = null;
          applyRemoteSelection(pending);
        }
      });
    });
  }).catch(function () {
    loadingEl.hidden = true;
    notFoundEl.hidden = false;
  });
})();
