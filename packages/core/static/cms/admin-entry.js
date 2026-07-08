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
  if (!API || !COLLECTION || !ID) return;

  /* ─── State ─────────────────────────────────────────────────────── */
  var entryData = null;
  var entrySchema = null;
  var entryRevision = undefined;
  var originalJson = "";
  var saving = false;
  var dirtyTimer = 0;

  /* ─── DOM refs ──────────────────────────────────────────────────── */
  var loadingEl = document.getElementById("loading");
  var notFoundEl = document.getElementById("not-found");
  var editorEl = document.getElementById("editor");
  var fieldsEl = document.getElementById("fields");
  var titleEl = document.getElementById("entry-title");
  var statusEl = document.getElementById("status-msg");
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

  // Coerce a text-input value back to the field's declared (or original) type so
  // editing an object-array's numeric/boolean/nested field doesn't turn it into a
  // string. Unparseable input returns the raw string (server validation reports it).
  function coerceScalarValue(raw, propSchema, originalVal) {
    var type = (propSchema && propSchema.type) ||
      (typeof originalVal === "number" ? "number" :
        typeof originalVal === "boolean" ? "boolean" :
          (originalVal && typeof originalVal === "object" ? "object" : "string"));
    if (type === "number" || type === "integer") {
      if (raw.trim() === "") return null;
      var n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    if (type === "boolean") {
      var t = raw.trim().toLowerCase();
      if (t === "true") return true;
      if (t === "false") return false;
      return raw;
    }
    if (type === "object" || type === "array") {
      try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
  }

  function isDirty() {
    return entryData !== null && JSON.stringify(entryData) !== originalJson;
  }

  function updateSaveButton() {
    var dirty = isDirty();
    saveBtn.disabled = !dirty || saving;
    saveBtn.classList.remove("studio-save-dirty", "studio-save-clean", "studio-save-saving");
    saveBtn.classList.add(saving ? "studio-save-saving" : (dirty ? "studio-save-dirty" : "studio-save-clean"));
    saveBtn.textContent = saving ? "Saving…" : "Save";
    titleEl.textContent = getTitle(entryData);
  }

  function showStatus(type, msg) {
    statusEl.textContent = msg;
    statusEl.hidden = false;
    statusEl.style.color = type === "saved" ? "var(--studio-green)" : "var(--studio-red)";
    if (type === "saved") {
      setTimeout(function () { statusEl.hidden = true; }, 2000);
    }
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
  }

  function loginRedirect() {
    window.location.href = MOUNT + "?redirect=" + encodeURIComponent(window.location.pathname);
  }

  function handleAuth(res) {
    if (res.status === 401) { loginRedirect(); return true; }
    return false;
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

  /* ─── Save / Delete ─────────────────────────────────────────────── */
  function save() {
    if (!entryData || saving) return;
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
          showStatus("error", "Validation failed (" + result.body.issues.length + ")");
          var firstErr = fieldsEl.querySelector(".studio-field-error");
          if (firstErr) firstErr.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        if (result.status === 409 && result.body && typeof result.body.currentRevision === "number") {
          // Your edits are still in the form; we've refreshed to the server's
          // revision, so saving again overwrites. Don't tell the user to reload
          // (that would throw their edits away).
          entryRevision = result.body.currentRevision;
          showStatus("error", "Changed elsewhere — Save again to overwrite");
          return;
        }
        throw new Error("save failed");
      }
      clearFieldErrors();
      if (result.body && typeof result.body.revision === "number") entryRevision = result.body.revision;
      originalJson = JSON.stringify(entryData);
      if (window.parent !== window) {
        try {
          window.parent.postMessage(
            { type: "cms:saved", collection: COLLECTION, id: ID, data: deepClone(entryData) },
            window.location.origin,
          );
        } catch (e) { /* noop */ }
      }
      showStatus("saved", "Saved");
    }).catch(function () {
      showStatus("error", "Error");
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
    deleteConfirmBtn.textContent = "Deleting…";
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
      window.location.href = MOUNT + "/cms/" + encodeURIComponent(COLLECTION);
    }).catch(function () {
      deleteDialog.hidden = true;
      deleteConfirmBtn.disabled = false;
      deleteConfirmBtn.textContent = "Delete";
      showStatus("error", "Delete failed");
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
      var control = wrapper.querySelector("input, select, textarea");
      if (!control) return;
      var fid = fieldIdFromPath(path);
      if (!control.id) control.id = fid;
      if (!control.name) control.name = path;
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
        if (prop.default !== undefined) data[key] = deepClone(prop.default);
        else if (prop.type === "object") data[key] = {};
        else if (prop.type === "array") data[key] = [];
        else if (prop.type === "boolean") data[key] = false;
        else if (prop.type === "number") data[key] = 0;
        else if (prop.type === "string" && prop.enum) data[key] = prop.enum[0];
        else if (prop.type === "string") data[key] = "";
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
      } else if (prop.type === "string" && prop.format === "textarea") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var ta = document.createElement("textarea");
        ta.className = "studio-input";
        ta.rows = 4;
        ta.value = current || "";
        ta.addEventListener("input", function () { updateField(path, ta.value); });
        group.appendChild(ta);
      } else if (prop.type === "string" && (prop.format === "email" || prop.format === "uri")) {
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
        group.appendChild(toggle);
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
            '<button class="caret-gallery-remove" type="button" title="Remove">×</button>' +
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

    function rerender() {
      wrapper.innerHTML = "";
      var current = getNestedValue(entryData, path) || "";

      if (current) {
        var preview = document.createElement("div");
        preview.className = "caret-single-image-preview";
        preview.innerHTML = '<img src="' + current + '" alt="" />';
        wrapper.appendChild(preview);
      }

      var row = document.createElement("div");
      row.className = "caret-single-image-row";

      var input = document.createElement("input");
      input.type = "text";
      input.className = "studio-input";
      input.style.flex = "1";
      input.value = current;
      input.placeholder = "Image URL";
      input.addEventListener("input", function () { updateField(path, input.value); });
      input.addEventListener("blur", rerender);

      var uploadBtn = document.createElement("button");
      uploadBtn.type = "button";
      uploadBtn.className = "studio-btn-ghost";
      uploadBtn.textContent = "Upload";

      var fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/jpeg,image/png,image/webp,image/avif";
      fileInput.style.display = "none";

      uploadBtn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        uploadBtn.textContent = "Uploading…";
        uploadBtn.disabled = true;
        uploadFile(file).then(function (newUrl) {
          updateField(path, newUrl);
          rerender();
        }).catch(function () {
          uploadBtn.textContent = "Upload";
          uploadBtn.disabled = false;
        });
        fileInput.value = "";
      });

      row.appendChild(input);
      row.appendChild(uploadBtn);
      row.appendChild(fileInput);
      wrapper.appendChild(row);
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
          btn.title = "Remove";
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

    function rerender() {
      wrapper.innerHTML = "";
      var current = getNestedValue(entryData, path) || [];

      current.forEach(function (item, idx) {
        var card = document.createElement("div");
        card.className = "caret-object-array-item";

        var removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "caret-object-array-remove";
        removeBtn.title = "Remove item";
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", function () {
          var next = current.slice();
          next.splice(idx, 1);
          updateField(path, next);
          rerender();
        });
        card.appendChild(removeBtn);

        var idxLabel = document.createElement("span");
        idxLabel.className = "caret-object-array-index";
        idxLabel.textContent = "[" + idx + "]";
        card.appendChild(idxLabel);

        var fieldsCont = document.createElement("div");
        fieldsCont.className = "caret-object-array-fields";

        var keys = (itemSchema && itemSchema.properties) ? Object.keys(itemSchema.properties) : Object.keys(item);
        keys.forEach(function (key) {
          var itemPath = path + "." + idx + "." + key;
          var val = item[key];
          var propSchema = itemSchema && itemSchema.properties && itemSchema.properties[key];
          var fieldLabel = (propSchema && propSchema.title) || humanizeKey(key);

          var row = document.createElement("div");
          row.className = "caret-object-array-row";

          var keyLabel = document.createElement("span");
          keyLabel.className = "caret-object-array-key";
          keyLabel.textContent = fieldLabel;

          var input = document.createElement("input");
          input.type = "text";
          input.className = "studio-input";
          input.value = typeof val === "string" ? val : (val == null ? "" : JSON.stringify(val));
          // Write back in the field's declared (or original) type, not always a
          // string — otherwise editing a number/boolean/nested field silently
          // rewrites it as text. Unparseable input falls back to the raw string
          // so server-side validation can report it.
          input.addEventListener("input", function () {
            updateField(itemPath, coerceScalarValue(input.value, propSchema, val));
          });

          row.appendChild(keyLabel);
          row.appendChild(input);
          fieldsCont.appendChild(row);
        });

        card.appendChild(fieldsCont);
        wrapper.appendChild(card);
      });

      var addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.className = "caret-object-array-add";
      addBtn.textContent = "+ Add item";
      addBtn.addEventListener("click", function () {
        var template;
        if (itemSchema && itemSchema.properties) {
          template = {};
          Object.keys(itemSchema.properties).forEach(function (k) {
            var s = itemSchema.properties[k];
            template[k] = s.type === "number" || s.type === "integer" ? 0 : (s.type === "boolean" ? false : "");
          });
        } else {
          template = current.length > 0
            ? Object.fromEntries(Object.keys(current[0]).map(function (k) { return [k, ""]; }))
            : {};
        }
        updateField(path, current.concat([template]));
        rerender();
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
      showStatus("saved", "Restored");
    }).catch(function () {
      showStatus("error", "Restore failed");
    });
  }

  /* ─── Wire events ───────────────────────────────────────────────── */
  saveBtn.addEventListener("click", save);
  deleteBtn.addEventListener("click", deleteEntry);
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
        if (!entry) {
          notFoundEl.hidden = false;
          return;
        }
        entryData = deepClone(entry.data);
        entryRevision = typeof entry.revision === "number" ? entry.revision : undefined;
        originalJson = JSON.stringify(entry.data);
        titleEl.textContent = getTitle(entryData);
        renderFields(fieldsEl, entryData, entrySchema, "");
        updateSaveButton();
        editorEl.hidden = false;
      });
    });
  }).catch(function () {
    loadingEl.hidden = true;
    notFoundEl.hidden = false;
  });
})();
