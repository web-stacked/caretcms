import { deepClone, fillDefaults, templateFromSchema, generatedId, friendlyFileTitle, singularItemLabel, getTitle, humanizeKey, fieldIdFromPath, getNestedValue, setNestedValue } from './studio/field-model.js';
import { createFieldGroup, createFieldRenderer } from './studio/fields.js';
import { createStudioMutationClient } from './studio/mutation-client.js';
import { createStudioHistoryClient } from './studio/history-client.js';
import { createStudioUploadClient } from './studio/upload-client.js';
import { createStudioEntryLoader } from './studio/entry-loader.js';
import { createStudioSync } from './studio/sync-client.js';
import { rebaseEdits } from './studio/merge.js';
import { historyChanges, historyFieldLabel, historyValueText, relativeTime } from './studio/history-view.js';
import { presentPublishResult } from './editor/publish-result.js';
import { whenServed } from './editor/image-utils.js';

/** @typedef {import('../../src/schema-utils.js').JsonSchemaNode} Schema */
/** @typedef {{ path: string, message: string }} ValidationIssue */
/** @typedef {{ apiBasePath?: string, mountPath?: string, collection?: string, id?: string, isNew?: boolean, initializeIfMissing?: boolean, saveTarget?: string, previewPath?: string, titleField?: string | null, fallbackTitle?: string | null, publicationField?: string | null, editable?: boolean, messages?: Record<string, string> }} EntryConfig */

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
 *   GET  ${api}/schema?collection=&id=   (id: infer a schemaless entry from itself)
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
  /** @type {number | undefined} */
  var entryBaseRevision = undefined;
  var originalJson = "";
  var saving = false;
  var dirtyTimer = 0;
  var linkedSelectionTimer = 0;
  /** @type {Record<string, unknown> | null} */
  var pendingRemoteSelection = null;
  /** @type {string | null} */
  var publicationFieldName = null;
  /** What visitors see when edits go to a private draft (null: not published
   * yet; undefined: edits save live, or the server didn't say).
   * @type {Record<string, unknown> | null | undefined} */
  var liveData = undefined;
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
  var visibilityEl = /** @type {HTMLElement | null} */ (document.getElementById("visibility-status"));
  var validationWarningEl = /** @type {HTMLElement | null} */ (document.getElementById("validation-warning"));
  var saveBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-save"));
  var deleteBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-delete"));
  var publishBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-publish"));
  var discardDraftBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-discard-draft"));
  var draftChangesEl = /** @type {HTMLDetailsElement | null} */ (document.getElementById("draft-changes"));
  var historyBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-history"));
  var historyPanel = /** @type {HTMLElement} */ (document.getElementById("history-panel"));
  var historyList = /** @type {HTMLElement} */ (document.getElementById("history-list"));
  var historyCloseBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-history-close"));
  var confirmDialog = /** @type {HTMLElement} */ (document.getElementById("confirm-dialog"));
  var confirmTitleEl = /** @type {HTMLElement} */ (document.getElementById("confirm-dialog-title"));
  var confirmCopyEl = /** @type {HTMLElement} */ (document.getElementById("confirm-dialog-copy"));
  var confirmCancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-confirm-cancel"));
  var confirmActionBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-confirm-action"));
  var conflictDialog = /** @type {HTMLElement} */ (document.getElementById("conflict-dialog"));
  var conflictFieldsEl = /** @type {HTMLElement} */ (document.getElementById("conflict-fields"));
  var conflictCancelBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-conflict-cancel"));
  var conflictLatestBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-conflict-latest"));
  var conflictKeepBtn = /** @type {HTMLButtonElement} */ (document.getElementById("btn-conflict-keep"));

  /* ─── Helpers ───────────────────────────────────────────────────── */

  function isDirty() {
    return entryData !== null && JSON.stringify(entryData) !== originalJson;
  }

  // A new entry opened from the create dialog: nothing is stored until the
  // editor presses Create with the required fields filled in.
  var creating = false;

  // Edits save on their own ~1.5s after the last change. A save requested
  // while one is running goes out as soon as it finishes.
  var AUTOSAVE_DELAY_MS = 1500;
  var AUTOSAVE = { auto: true };
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  var autosaveTimer;
  var saveAgain = false;
  // The entry as it was before the last save, for Undo.
  /** @type {Record<string, unknown> | null} */
  var undoData = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  var undoTimer;
  var undoBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-undo"));

  /** Whether a change goes beyond text the page can update in place.
   * @param {unknown} before @param {unknown} after @returns {boolean} */
  function hasStructuralChange(before, after) {
    if (typeof before === "string" && typeof after === "string") return false;
    if (Array.isArray(before) || Array.isArray(after)) {
      if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return true;
      return before.some(function (item, index) { return hasStructuralChange(item, after[index]); });
    }
    if (before && after && typeof before === "object" && typeof after === "object") {
      var a = /** @type {Record<string, unknown>} */ (before), b = /** @type {Record<string, unknown>} */ (after);
      var keys = Object.keys(a).concat(Object.keys(b).filter(function (key) { return !(key in a); }));
      return keys.some(function (key) { return hasStructuralChange(a[key], b[key]); });
    }
    return before !== after;
  }

  /** @param {Record<string, unknown> | null} previous */
  function offerUndo(previous) {
    undoData = previous;
    if (!undoBtn) return;
    undoBtn.hidden = previous === null;
    clearTimeout(undoTimer);
    if (previous) undoTimer = setTimeout(function () { if (undoBtn) undoBtn.hidden = true; undoData = null; }, 10000);
  }

  /** Empty required text fields, so a new entry never starts with placeholder content.
   * @param {Record<string, unknown>} data @param {Schema | null} schema */
  function blankRequiredText(data, schema) {
    if (!schema || !schema.properties) return;
    var required = schema.required || [];
    Object.keys(schema.properties).forEach(function (key) {
      var prop = /** @type {Schema} */ (schema.properties && schema.properties[key]);
      if (!prop) return;
      if (prop.type === "string" && required.indexOf(key) !== -1) data[key] = "";
      else if (prop.type === "object" && data[key] && typeof data[key] === "object" && !Array.isArray(data[key])) {
        blankRequiredText(/** @type {Record<string, unknown>} */ (data[key]), prop);
      }
    });
  }

  /** Text a reader sees in a title value. @param {unknown} value */
  function titleText(value) {
    return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "";
  }

  /** Mirrors the server's entryDisplayTitle, kept current as fields change. @param {Record<string, unknown> | null} data */
  function displayTitle(data) {
    // A singleton (site settings) is named by its collection, as on the server.
    if (INITIALIZE_IF_MISSING && CFG.fallbackTitle) return CFG.fallbackTitle;
    var configured = data && CFG.titleField ? titleText(getNestedValue(data, CFG.titleField)) : "";
    if (configured) return configured;
    var inferred = titleText(getTitle(data));
    if (inferred && inferred !== "Untitled") return inferred;
    return CFG.fallbackTitle || (IS_NEW ? inferred : ID);
  }

  function updateDisplayedTitle() {
    var title = displayTitle(entryData);
    titleEl.textContent = title;
    document.title = document.title.replace(/^Edit .*?(?= — )/, "Edit " + title);
  }

  /** @param {unknown} value @returns {string} */
  function stableJson(value) {
    if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
    if (value && typeof value === "object") {
      var record = /** @type {Record<string, unknown>} */ (value);
      return "{" + Object.keys(record).sort().map(function (key) { return JSON.stringify(key) + ":" + stableJson(record[key]); }).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  /** Whether the saved draft differs from what visitors see. */
  function hasUnpublishedDraft() {
    if (SAVE_TARGET !== "preview" || liveData === undefined) return true;
    if (liveData === null) return true;
    return stableJson(fillDefaults(deepClone(liveData), entrySchema)) !== stableJson(JSON.parse(originalJson || "{}"));
  }

  function savedStatusMessage() {
    if (SAVE_TARGET !== "preview") return msg("entry.allLive", "All changes live");
    return hasUnpublishedDraft() ? msg("entry.draftSaved", "Draft saved") : msg("entry.matchesLive", "Matches live");
  }

  function updateVisibility() {
    if (!visibilityEl || !entryData || !CFG.publicationField) return;
    var visible = getNestedValue(entryData, CFG.publicationField) === true;
    var label = visible ? msg("entry.public", "Public") : msg("entry.hidden", "Hidden");
    // In draft modes the switch only takes effect when the draft is published.
    if (SAVE_TARGET === "preview" && liveData !== undefined) {
      var liveVisible = liveData !== null && getNestedValue(liveData, CFG.publicationField) === true;
      if (visible !== liveVisible) {
        label = visible ? msg("entry.publicAfterPublish", "Public after publish") : msg("entry.hiddenAfterPublish", "Hidden after publish");
      }
    }
    visibilityEl.textContent = label;
    visibilityEl.dataset.visible = visible ? "true" : "false";
  }

  // Draft modes: what this entry's draft changes compared with what visitors
  // see, and the Publish and Discard actions for it.
  var canPublish = true;
  var publishing = false;

  function updateDraftUi() {
    if (!draftChangesEl || SAVE_TARGET !== "preview" || liveData === undefined || !entryData || creating) return;
    var saved = /** @type {Record<string, unknown>} */ (JSON.parse(originalJson || "{}"));
    var unpublished = hasUnpublishedDraft();
    var title = /** @type {HTMLElement} */ (document.getElementById("draft-changes-title"));
    var list = /** @type {HTMLElement} */ (document.getElementById("draft-changes-list"));
    list.innerHTML = "";
    if (unpublished) {
      if (liveData === null) {
        title.textContent = msg("entry.newNotPublished", "New, not published yet");
      } else {
        var changes = historyChanges(fillDefaults(deepClone(liveData), entrySchema), saved, entrySchema, msg("history.empty", "Empty"));
        title.textContent = changes.length === 1
          ? msg("entry.draftChangesOne", "1 change not published yet")
          : msg("entry.draftChanges", "{count} changes not published yet").replace("{count}", String(changes.length));
        changes.forEach(function (change) { list.appendChild(historyChangeItem(change)); });
      }
    }
    draftChangesEl.hidden = !unpublished;
    if (publishBtn) {
      publishBtn.hidden = !unpublished || !canPublish;
      publishBtn.disabled = publishing || isDirty() || saving;
    }
    if (discardDraftBtn) discardDraftBtn.hidden = !unpublished;
  }

  function publishEntry() {
    if (!publishBtn || publishing) return;
    publishing = true;
    publishBtn.textContent = msg("entry.publishing", "Publishing…");
    updateDraftUi();
    showStatus("saving", msg("entry.publishing", "Publishing…"));
    fetch(API + "/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-caret-request": "1" },
      credentials: "same-origin",
      body: JSON.stringify({ collection: COLLECTION, id: ID }),
    }).then(function (response) {
      if (response.status === 401) { loginRedirect(); return; }
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) {
          showStatus("error", typeof body.error === "string" ? body.error : msg("common.error", "Error"));
          return;
        }
        var result = presentPublishResult(body);
        showStatus(result.toast.kind === "error" ? "error" : "saved", result.toast.message);
        studioSync.announceChange("cms:published", entryData);
        // Publishing moves the draft into what visitors see, which changes this
        // entry's versions: take the new ones so the next save isn't stale.
        return entryLoader.load({ collection: COLLECTION, id: ID, isNew: false, initializeIfMissing: false }).then(function (latest) {
          if (latest.kind !== "ready") return;
          entryRevision = latest.revision;
          entryBaseRevision = latest.baseRevision;
          liveData = latest.live;
        });
      });
    }).catch(function () {
      showStatus("error", msg("common.error", "Error"));
    }).then(function () {
      publishing = false;
      if (publishBtn) publishBtn.textContent = msg("entry.publish", "Publish");
      updateVisibility();
      updateDraftUi();
    });
  }

  async function discardEntryDraft() {
    var moreMenu = document.getElementById("entry-more");
    if (moreMenu) moreMenu.removeAttribute("open");
    if (!(await confirmAction({
      title: msg("entry.discardTitle", "Discard your draft?"),
      copy: msg("entry.discardCopy", "This entry goes back to what visitors see now, and your unpublished changes are removed."),
      action: msg("entry.discardDraft", "Discard draft"),
    }))) return;
    var response = await fetch(API + "/draft?collection=" + encodeURIComponent(COLLECTION) + "&id=" + encodeURIComponent(ID), {
      method: "DELETE",
      headers: { "x-caret-request": "1" },
      credentials: "same-origin",
    }).catch(function () { return null; });
    if (response && response.status === 401) { loginRedirect(); return; }
    if (!response || !response.ok) {
      var body = response ? await response.json().catch(function () { return {}; }) : {};
      showStatus("error", typeof body.error === "string" ? body.error : msg("common.error", "Error"));
      return;
    }
    // The entry is now what visitors see; load it fresh.
    window.location.reload();
  }

  /** @param {boolean} [preserveStatus] */
  function updateSaveButton(preserveStatus) {
    var dirty = isDirty();
    saveBtn.disabled = CFG.editable === false || (!dirty && !creating) || saving;
    saveBtn.classList.remove("studio-save-dirty", "studio-save-clean", "studio-save-saving");
    saveBtn.classList.add(saving ? "studio-save-saving" : (dirty || creating ? "studio-save-dirty" : "studio-save-clean"));
    saveBtn.textContent = saving ? msg("common.saving", "Saving…")
      : creating ? msg("entry.create", "Create")
      : (SAVE_TARGET === "preview" ? msg("entry.saveDraft", "Save draft") : msg("entry.saveLive", "Save live"));
    updateDisplayedTitle();
    updateVisibility();
    updateDraftUi();
    studioSync.announceStatus(dirty);
    if (entryData !== null && !preserveStatus) {
      if (saving) showStatus("saving", SAVE_TARGET === "preview" ? msg("entry.savingDraft", "Saving draft…") : msg("entry.savingLiveChanges", "Saving live changes…"));
      else if (creating) showStatus("dirty", msg("entry.notCreated", "Not created yet"));
      else if (dirty) showStatus("dirty", msg("entry.unsaved", "Unsaved changes"));
      else showStatus("saved", savedStatusMessage());
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
    offerUndo(null);
    clearTimeout(autosaveTimer);
    if (!creating && CFG.editable !== false) autosaveTimer = setTimeout(function () { save(AUTOSAVE); }, AUTOSAVE_DELAY_MS);
  }

  function loginRedirect() {
    window.location.href = MOUNT + "?redirect=" + encodeURIComponent(window.location.pathname);
  }

  /** @param {Response} res */
  function handleAuth(res) {
    if (res.status === 401) { loginRedirect(); return true; }
    return false;
  }

  /** @param {{ title: string, copy: string, action: string, danger?: boolean }} options */
  function confirmAction(options) {
    var restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmTitleEl.textContent = options.title;
    confirmCopyEl.textContent = options.copy;
    confirmActionBtn.textContent = options.action;
    confirmActionBtn.className = options.danger ? "studio-btn-danger studio-btn-danger-confirm" : "studio-btn-primary";
    confirmDialog.hidden = false;
    confirmCancelBtn.focus();
    return new Promise(function (resolve) {
      /** @param {boolean} accepted */
      function finish(accepted) {
        confirmDialog.hidden = true;
        confirmCancelBtn.removeEventListener("click", cancel);
        confirmActionBtn.removeEventListener("click", accept);
        confirmDialog.removeEventListener("click", backdrop);
        confirmDialog.removeEventListener("keydown", keydown);
        if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
        resolve(accepted);
      }
      function cancel() { finish(false); }
      function accept() { finish(true); }
      /** @param {MouseEvent} event */
      function backdrop(event) { if (event.target === confirmDialog) finish(false); }
      /** @param {KeyboardEvent} event */
      function keydown(event) {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false); return; }
        if (event.key !== "Tab") return;
        if (event.shiftKey && document.activeElement === confirmCancelBtn) {
          event.preventDefault(); confirmActionBtn.focus();
        } else if (!event.shiftKey && document.activeElement === confirmActionBtn) {
          event.preventDefault(); confirmCancelBtn.focus();
        }
      }
      confirmCancelBtn.addEventListener("click", cancel);
      confirmActionBtn.addEventListener("click", accept);
      confirmDialog.addEventListener("click", backdrop);
      confirmDialog.addEventListener("keydown", keydown);
    });
  }

  /** A field as the form labels it, e.g. "Team › #2 › Name". @param {string} path */
  function humanizePath(path) {
    return historyFieldLabel(path, entrySchema);
  }

  /**
   * Show what the other person saved next to your version, field by field.
   * @param {string[]} theirChanges @param {string[]} overlapping
   * @param {unknown} theirData @param {unknown} myData
   */
  function resolveConflict(theirChanges, overlapping, theirData, myData) {
    var restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : saveBtn;
    var empty = msg("history.empty", "Empty");
    conflictFieldsEl.innerHTML = "";
    /** @param {HTMLElement} item @param {string} label @param {unknown} value */
    function version(item, label, value) {
      var line = document.createElement("span");
      line.className = "conflict-version";
      var name = document.createElement("span");
      name.className = "conflict-version-label";
      name.textContent = label;
      line.appendChild(name);
      line.appendChild(document.createTextNode(historyValueText(value, empty)));
      item.appendChild(line);
    }
    (theirChanges.length ? theirChanges : [""]).forEach(function (path) {
      var item = document.createElement("li");
      if (path === "") {
        item.textContent = msg("entry.conflictRevision", "The entry revision changed");
      } else {
        var field = document.createElement("strong");
        field.textContent = humanizePath(path);
        item.appendChild(field);
        version(item, msg("entry.conflictTheirs", "Saved by someone else:"), getNestedValue(theirData, path));
        if (overlapping.indexOf(path) >= 0) version(item, msg("entry.conflictYours", "Yours:"), getNestedValue(myData, path));
        else {
          var kept = document.createElement("span");
          kept.className = "conflict-version conflict-version-note";
          kept.textContent = msg("entry.conflictKept", "You didn't change this, so it's kept either way.");
          item.appendChild(kept);
        }
      }
      conflictFieldsEl.appendChild(item);
    });
    conflictDialog.hidden = false;
    conflictCancelBtn.focus();
    return new Promise(function (resolve) {
      /** @param {'cancel' | 'latest' | 'keep'} choice */
      function finish(choice) {
        conflictDialog.hidden = true;
        conflictCancelBtn.removeEventListener("click", cancel);
        conflictLatestBtn.removeEventListener("click", latestAction);
        conflictKeepBtn.removeEventListener("click", keep);
        conflictDialog.removeEventListener("click", backdrop);
        conflictDialog.removeEventListener("keydown", keydown);
        if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
        resolve(choice);
      }
      function cancel() { finish("cancel"); }
      function latestAction() { finish("latest"); }
      function keep() { finish("keep"); }
      /** @param {MouseEvent} event */
      function backdrop(event) { if (event.target === conflictDialog) finish("cancel"); }
      /** @param {KeyboardEvent} event */
      function keydown(event) {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish("cancel"); return; }
        if (event.key !== "Tab") return;
        var controls = [conflictCancelBtn, conflictLatestBtn, conflictKeepBtn];
        var first = controls[0];
        var last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      conflictCancelBtn.addEventListener("click", cancel);
      conflictLatestBtn.addEventListener("click", latestAction);
      conflictKeepBtn.addEventListener("click", keep);
      conflictDialog.addEventListener("click", backdrop);
      conflictDialog.addEventListener("keydown", keydown);
    });
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
    // A file name isn't a description: alt text is left for the editor, who
    // is taken to its field below.
    if (dimensions && Object.prototype.hasOwnProperty.call(next, "width")) next.width = dimensions.width;
    if (dimensions && Object.prototype.hasOwnProperty.call(next, "height")) next.height = dimensions.height;
    updateField(parentPath, next);

    ["id", "title", "alt", "width", "height"].forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(next, key)) return;
      var control = document.getElementById(fieldIdFromPath(parentPath + "." + key));
      if (control && "value" in control) control.value = String(next[key]);
    });
    var altControl = Object.prototype.hasOwnProperty.call(next, "alt") && !next.alt
      ? document.getElementById(fieldIdFromPath(parentPath + ".alt")) : null;
    if (altControl instanceof HTMLElement) {
      var focusAlt = altControl;
      requestAnimationFrame(function () { focusAlt.focus(); });
    }
  }

  /* ─── Save / Delete ─────────────────────────────────────────────── */
  /** @param {unknown} [options] `AUTOSAVE` for a save the editor didn't ask for. */
  async function save(options) {
    var auto = options === AUTOSAVE;
    clearTimeout(autosaveTimer);
    if (!entryData) return;
    if (saving) { saveAgain = true; return; }
    if (auto && (!isDirty() || creating)) return;
    saving = true;
    updateSaveButton();
    var preserveSaveStatus = false;
    /** @type {{ collection: string, id: string, data: Record<string, unknown>, expectedRevision?: number, expectedBaseRevision?: number, createOnly?: boolean }} */
    var payload = {
      collection: COLLECTION,
      id: ID,
      data: entryData,
    };
    if (typeof entryRevision === "number") payload.expectedRevision = entryRevision;
    if (typeof entryBaseRevision === "number") payload.expectedBaseRevision = entryBaseRevision;
    if (creating) payload.createOnly = true;

    mutationClient.save(payload).then(async function (result) {
      if (result.kind === "unauthorized") { loginRedirect(); return; }
      if (result.kind === "validation") {
          preserveSaveStatus = true;
          var firstInvalid = showValidationErrors(result.issues);
          if (auto) {
            // Point at the fields without moving the editor's cursor.
            showStatus("error", msg("entry.fixFields", "Not saved — fix the highlighted fields"));
            return;
          }
          showStatus("error", msg("entry.validationFailed", "Validation failed") + " (" + result.issues.length + ")");
          if (firstInvalid) {
            firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
            firstInvalid.focus({ preventScroll: true });
          }
          return;
      }
      if (result.kind === "conflict") {
          preserveSaveStatus = true;
          // The newer revision is adopted only once the editor chooses a
          // version. Until then saves keep conflicting, so this stale copy can
          // never overwrite what someone else saved.
          var latest = await entryLoader.load({ collection: COLLECTION, id: ID, isNew: false, initializeIfMissing: false });
          if (latest.kind !== "ready") {
            showStatus("error", msg("entry.changedElsewhere", "Changed elsewhere — your edits are still here"));
            return;
          }
          var theirs = fillDefaults(deepClone(latest.data), entrySchema);
          var rebase = rebaseEdits(JSON.parse(originalJson || "{}"), entryData || {}, theirs);
          showStatus("dirty", msg("entry.conflictStatus", "Someone else saved this entry. Choose which version to keep."));
          var choice = await resolveConflict(rebase.theirChanges, rebase.overlapping, theirs, entryData);
          if (choice === "latest" || choice === "keep") {
            entryRevision = latest.revision;
            entryBaseRevision = latest.baseRevision;
          }
          if (choice === "latest") {
            entryData = fillDefaults(deepClone(latest.data), entrySchema);
            originalJson = JSON.stringify(entryData);
            fieldsEl.innerHTML = "";
            renderFields(fieldsEl, entryData, entrySchema, "");
            studioSync.queuePreview(entryData);
            showStatus("saved", msg("entry.loadedLatest", "Loaded latest changes"));
          } else if (choice === "keep") {
            // Apply only this form's edits on top of the newer entry, so
            // fields changed elsewhere and untouched here are not reverted.
            entryData = fillDefaults(rebase.merged, entrySchema);
            originalJson = JSON.stringify(fillDefaults(deepClone(latest.data), entrySchema));
            fieldsEl.innerHTML = "";
            renderFields(fieldsEl, entryData, entrySchema, "");
            studioSync.queuePreview(entryData);
            showStatus("dirty", msg("entry.keptMine", "Your edits are on the latest version — Save to apply them"));
          } else {
            showStatus("dirty", msg("entry.unsaved", "Unsaved changes"));
          }
          return;
      }
      if (result.kind === "error") throw new Error("save failed");
      clearFieldErrors();
      if (typeof result.revision === "number") entryRevision = result.revision;
      if (creating) {
        creating = false;
        history.replaceState(null, "", window.location.pathname);
      }
      var previous = /** @type {Record<string, unknown>} */ (JSON.parse(originalJson || "{}"));
      var wasUndo = Boolean(options && /** @type {{ undo?: boolean }} */ (options).undo);
      originalJson = JSON.stringify(entryData);
      studioSync.announceChange("cms:saved", entryData, { structural: hasStructuralChange(previous, entryData) });
      if (wasUndo) {
        offerUndo(null);
        preserveSaveStatus = true;
        showStatus("saved", msg("entry.undone", "Change undone"));
      } else {
        offerUndo(previous);
        showStatus("saved", SAVE_TARGET === "preview" ? savedStatusMessage() : msg("entry.savedLive", "Changes are live"));
      }
    }).catch(function () {
      preserveSaveStatus = true;
      showStatus("error", msg("common.error", "Error"));
    }).then(function () {
      saving = false;
      updateSaveButton(preserveSaveStatus);
      if (saveAgain) {
        saveAgain = false;
        if (isDirty()) save(AUTOSAVE);
      }
    });
  }

  // Undo puts back the entry as it was before the last save, and saves it.
  if (undoBtn) undoBtn.addEventListener("click", function () {
    if (!undoData || saving) return;
    entryData = fillDefaults(deepClone(undoData), entrySchema);
    offerUndo(null);
    fieldsEl.innerHTML = "";
    renderFields(fieldsEl, entryData, entrySchema, "");
    studioSync.queuePreview(entryData);
    save({ undo: true });
  });

  // Deleting hands the entry to the collection page, which hides it, offers
  // Undo and sends the deletion a few seconds later; see collection-list.ts.
  function deleteEntry() {
    var moreMenu = document.getElementById("entry-more");
    if (moreMenu && moreMenu.hasAttribute("open")) moreMenu.removeAttribute("open");
    var pending = {
      collection: COLLECTION, id: ID, title: displayTitle(entryData), at: Date.now(),
      revision: entryRevision, baseRevision: entryBaseRevision,
    };
    try {
      sessionStorage.setItem("caret:pending-delete", JSON.stringify(pending));
    } catch (e) {
      // Without session storage there's no way to offer Undo; delete now.
      deleteNow();
      return;
    }
    window.location.href = MOUNT + "/cms/" + encodeURIComponent(COLLECTION);
  }

  function deleteNow() {
    /** @type {{ collection: string, id: string, expectedRevision?: number, expectedBaseRevision?: number }} */
    var payload = { collection: COLLECTION, id: ID };
    if (typeof entryRevision === "number") payload.expectedRevision = entryRevision;
    if (typeof entryBaseRevision === "number") payload.expectedBaseRevision = entryBaseRevision;
    mutationClient.remove(payload).then(function (result) {
      if (result === "unauthorized") { loginRedirect(); return; }
      if (result !== "deleted") throw new Error("delete failed");
      studioSync.announceChange("cms:deleted", null);
      window.location.href = MOUNT + "/cms/" + encodeURIComponent(COLLECTION);
    }).catch(function () {
      showStatus("error", msg("entry.deleteFailed", "Delete failed"));
    });
  }

  /* ─── Validation rendering ──────────────────────────────────────── */
  /** @param {Element} group @param {string} message */
  function showFieldError(group, message) {
    var control = group.querySelector("input, textarea, select, [contenteditable='true']");
    var errEl = group.querySelector(".studio-error-text");
    if (message) {
      if (!errEl) {
        errEl = document.createElement("p");
        errEl.className = "studio-error-text";
        group.appendChild(errEl);
      }
      errEl.textContent = message;
      var path = group instanceof HTMLElement ? group.dataset.fieldPath || "field" : "field";
      errEl.id = fieldIdFromPath(path) + "-error";
      /** @type {HTMLElement} */ (errEl).hidden = false;
      group.classList.add("studio-field-error");
      if (control instanceof HTMLElement) {
        control.setAttribute("aria-invalid", "true");
        var describedBy = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
        if (!describedBy.includes(errEl.id)) describedBy.push(errEl.id);
        control.setAttribute("aria-describedby", describedBy.join(" "));
      }
    } else if (errEl) {
      var errorId = errEl.id;
      if (control instanceof HTMLElement) {
        control.removeAttribute("aria-invalid");
        var ids = (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(function (id) { return id && id !== errorId; });
        if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
        else control.removeAttribute("aria-describedby");
      }
      errEl.remove();
      group.classList.remove("studio-field-error");
    }
  }

  function clearFieldErrors() {
    fieldsEl.querySelectorAll(".caret-field-group.studio-field-error").forEach(function (group) { showFieldError(group, ""); });
  }

  /** @param {ValidationIssue[]} issues @returns {HTMLElement | null} */
  function showValidationErrors(issues) {
    clearFieldErrors();
    /** @type {HTMLElement | null} */
    var firstControl = null;
    issues.forEach(function (issue) {
      var group = fieldsEl.querySelector('[data-field-path="' + cssEscape(issue.path) + '"]');
      if (group) {
        revealObjectArrayItem(group);
        var ancestor = group.parentElement;
        while (ancestor && ancestor !== fieldsEl) {
          if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
          ancestor = ancestor.parentElement;
        }
        showFieldError(group, issue.message);
        var control = group.querySelector("input, textarea, select, [contenteditable='true']");
        if (!firstControl && control instanceof HTMLElement) firstControl = control;
      }
    });
    return firstControl;
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

  /** @param {Element} element */
  function revealObjectArrayItem(element) {
    var nestedDetails = element.closest("details");
    if (nestedDetails instanceof HTMLDetailsElement) nestedDetails.open = true;
    var card = element.closest(".caret-object-array-item");
    if (!card) return;
    card.classList.add("is-expanded");
    var fields = card.querySelector(".caret-object-array-fields");
    if (fields instanceof HTMLElement) fields.hidden = false;
    var toggle = card.querySelector(".caret-object-array-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
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
    revealObjectArrayItem(group);
    showLinkedSelection(group);
    group.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  }

  /* ─── Field rendering ───────────────────────────────────────────── */

  // Without permission to edit, the form is for reading: every control is
  // disabled, including ones rendered later (list items, re-renders).
  if (CFG.editable === false) {
    var lockFields = function () {
      fieldsEl.querySelectorAll("input, textarea, select, button").forEach(function (control) {
        /** @type {HTMLInputElement} */ (control).disabled = true;
      });
      fieldsEl.querySelectorAll("[contenteditable='true'], [contenteditable='plaintext-only']").forEach(function (element) {
        element.setAttribute("contenteditable", "false");
      });
    };
    new MutationObserver(lockFields).observe(fieldsEl, { childList: true, subtree: true });
  }

  const { renderFields, renderFieldsFallback } = createFieldRenderer({
    updateField,
    buildSingleImage,
    buildImageGallery,
    buildObjectArray,
    buildTagList,
    getPublicationField: () => publicationFieldName,
    getMessage: msg,
    savesDraft: SAVE_TARGET === "preview",
  });

  /** Why an upload was refused, as the server explains it to editors. @param {unknown} error */
  function uploadErrorMessage(error) {
    var reason = error && typeof error === "object" && "reason" in error ? /** @type {{ reason: unknown }} */ (error).reason : null;
    return typeof reason === "string" && reason ? reason : msg("field.uploadFailed", "The image couldn't be uploaded. Try again.");
  }

  /* ─── Image gallery ─────────────────────────────────────────────── */
  /** @param {unknown} images @param {string} path */
  function buildImageGallery(images, path) {
    var wrapper = document.createElement("div");
    var galleryError = "";

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
      fileInput.setAttribute("aria-label", "Upload images for " + historyFieldLabel(path, entrySchema));
      fileInput.style.display = "none";

      /** @param {ArrayLike<File>} files */
      function handleFiles(files) {
        // Every file goes to the server, which says why any is refused.
        var valid = Array.from(files);
        if (!valid.length) return;
        galleryError = "";
        dropzone.innerHTML =
          '<div class="studio-spinner" style="margin-bottom:0.5rem;"></div>' +
          '<p style="margin:0;font-size:0.75rem;color:var(--studio-text-muted);">Uploading ' + valid.length + " image" + (valid.length > 1 ? "s" : "") + "…</p>";
        dropzone.style.pointerEvents = "none";

        var existingImages = getNestedValue(entryData, path);
        var imgs = Array.isArray(existingImages)
          ? existingImages.filter(function (value) { return typeof value === "string"; })
          : [];
        Promise.allSettled(valid.map(function (f) {
          return uploadClient.upload(f).then(function (url) { return whenServed(url).then(function () { return url; }); });
        })).then(function (results) {
          /** @type {string[]} */
          var refused = [];
          results.forEach(function (r, index) {
            if (r.status === "fulfilled") imgs.push(r.value);
            else refused.push(valid[index].name + ": " + uploadErrorMessage(r.reason));
          });
          galleryError = refused.join(" ");
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
      if (galleryError) {
        var refusedNote = document.createElement("p");
        refusedNote.className = "caret-image-help is-error";
        refusedNote.setAttribute("role", "status");
        refusedNote.textContent = galleryError;
        wrapper.appendChild(refusedNote);
      }
    }

    rerender();
    return wrapper;
  }

  /* ─── Single image ──────────────────────────────────────────────── */
  /** @param {unknown} url @param {string} path */
  function buildSingleImage(url, path) {
    var wrapper = document.createElement("div");
    wrapper.className = "caret-single-image";
    var errorMessage = "";

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
        emptyPreview.textContent = "+ " + msg("field.chooseImage", "Choose an image");
        emptyPreview.addEventListener("click", function () { fileInput.click(); });
        wrapper.appendChild(emptyPreview);
      }

      var urlDetails = document.createElement("details");
      urlDetails.className = "caret-image-url";
      var urlSummary = document.createElement("summary");
      urlSummary.textContent = msg("field.useImageUrl", "Use image URL");
      urlDetails.appendChild(urlSummary);

      var input = document.createElement("input");
      input.type = "text";
      input.className = "studio-input";
      input.id = fieldIdFromPath(path);
      input.name = path;
      input.style.flex = "1";
      input.value = current;
      input.placeholder = msg("field.imageUrl", "Image URL");
      input.setAttribute("aria-label", msg("field.imageUrl", "Image URL"));
      input.addEventListener("input", function () { updateField(path, input.value); });
      input.addEventListener("blur", rerender);
      urlDetails.appendChild(input);

      var status = document.createElement("p");
      status.className = "caret-image-help" + (errorMessage ? " is-error" : "");
      status.hidden = !errorMessage;
      status.setAttribute("role", "status");
      status.textContent = errorMessage;

      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        var selectedFile = file;
        errorMessage = "";
        var uploadAction = wrapper.querySelector(".caret-single-image-preview, .caret-single-image-empty");
        if (uploadAction instanceof HTMLButtonElement) {
          uploadAction.disabled = true;
          uploadAction.classList.add("is-uploading");
          var uploadLabel = uploadAction.querySelector(".caret-single-image-overlay");
          if (uploadLabel) uploadLabel.textContent = msg("field.uploading", "Uploading…");
          else uploadAction.textContent = msg("field.uploading", "Uploading…");
        }
        Promise.all([uploadClient.upload(selectedFile), uploadClient.readDimensions(selectedFile)]).then(function (results) {
          // Show the new image only once it's actually served.
          return whenServed(results[0]).then(function () { return results; });
        }).then(function (results) {
          updateField(path, results[0]);
          populateImageObject(path, selectedFile, results[1]);
          rerender();
        }).catch(function (error) {
          errorMessage = uploadErrorMessage(error);
          rerender();
        });
        fileInput.value = "";
      });

      wrapper.appendChild(urlDetails);
      wrapper.appendChild(status);
      wrapper.appendChild(fileInput);
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
          btn.setAttribute("aria-label", msg("field.remove", "Remove") + " " + item);
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
    /** @type {number | null} */
    var expandedIndex = null;

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
      if (expandedIndex === from) expandedIndex = to;
      else if (expandedIndex !== null && from < expandedIndex && expandedIndex <= to) expandedIndex -= 1;
      else if (expandedIndex !== null && to <= expandedIndex && expandedIndex < from) expandedIndex += 1;
      updateField(path, next);
      rerender();
      var movedToggle = wrapper.querySelector('[data-array-index="' + expandedIndex + '"] .caret-object-array-toggle');
      if (movedToggle instanceof HTMLElement) movedToggle.focus();
    }

    function rerender() {
      wrapper.innerHTML = "";
      var arrayValue = getNestedValue(entryData, path);
      var current = Array.isArray(arrayValue)
        ? arrayValue.filter(function (value) { return value !== null && typeof value === "object" && !Array.isArray(value); })
        : [];

      current.forEach(function (item, idx) {
        var card = document.createElement("div");
        card.className = "caret-object-array-item" + (expandedIndex === idx ? " is-expanded" : "");
        card.dataset.arrayIndex = String(idx);

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

        var thumbnailUrl = typeof item.src === "string" ? item.src : "";
        if (thumbnailUrl) {
          var thumbnail = document.createElement("img");
          thumbnail.className = "caret-object-array-thumbnail";
          thumbnail.src = thumbnailUrl;
          thumbnail.alt = "";
          header.appendChild(thumbnail);
        }

        var idxLabel = document.createElement("button");
        idxLabel.type = "button";
        idxLabel.className = "caret-object-array-index caret-object-array-toggle";
        var idxText = document.createElement("span");
        idxText.className = "caret-object-array-title";
        idxText.textContent = itemSummary(item, idx);
        idxLabel.appendChild(idxText);
        idxLabel.setAttribute("aria-expanded", expandedIndex === idx ? "true" : "false");
        idxLabel.setAttribute("aria-controls", fieldIdFromPath(path + "." + idx) + "-fields");
        idxLabel.addEventListener("click", function () {
          expandedIndex = expandedIndex === idx ? null : idx;
          rerender();
          var toggle = wrapper.querySelector('[data-array-index="' + idx + '"] .caret-object-array-toggle');
          if (toggle instanceof HTMLElement) toggle.focus();
        });
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
          if (!next.length) expandedIndex = null;
          else if (expandedIndex === idx) expandedIndex = Math.min(idx, next.length - 1);
          else if (expandedIndex !== null && expandedIndex > idx) expandedIndex -= 1;
          updateField(path, next);
          rerender();
          var nextToggle = wrapper.querySelector('[data-array-index="' + expandedIndex + '"] .caret-object-array-toggle');
          if (nextToggle instanceof HTMLElement) nextToggle.focus();
        });

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
        actions.appendChild(removeBtn);
        card.appendChild(header);

        var fieldsCont = document.createElement("div");
        fieldsCont.className = "caret-object-array-fields";
        fieldsCont.id = fieldIdFromPath(path + "." + idx) + "-fields";
        fieldsCont.hidden = expandedIndex !== idx;
        fieldsCont.appendChild(actions);

        if (itemSchema && itemSchema.properties) {
          renderFields(fieldsCont, item, itemSchema, path + "." + idx);
        } else {
          renderFieldsFallback(fieldsCont, item, path + "." + idx);
        }

        var technicalKeys = itemSchema && itemSchema.properties
          ? Object.keys(itemSchema.properties).filter(function (key) {
              var fieldSchema = itemSchema.properties?.[key];
              return fieldSchema?.["x-caret-technical"] === true || key === "id" || key === "width" || key === "height";
            })
          : [];
        var technicalFields = technicalKeys.map(function (key) {
          return fieldsCont.querySelector('[data-field-path="' + cssEscape(path + "." + idx + "." + key) + '"]');
        }).filter(Boolean);
        if (technicalFields.length) {
          var technical = document.createElement("details");
          technical.className = "caret-object-array-technical";
          var technicalSummary = document.createElement("summary");
          technicalSummary.textContent = msg("field.technicalDetails", "Technical details");
          technical.appendChild(technicalSummary);
          var technicalBody = document.createElement("div");
          technicalBody.className = "caret-object-array-technical-body";
          technicalFields.forEach(function (field) {
            if (field) technicalBody.appendChild(field);
          });
          technical.appendChild(technicalBody);
          fieldsCont.appendChild(technical);
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
        expandedIndex = current.length;
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
  /** @param {string} action */
  function historyActionLabel(action) {
    if (action === "restore") return msg("history.restored", "Restored");
    if (action === "delete") return msg("history.deleted", "Deleted");
    if (action === "publish") return msg("history.published", "Published");
    if (action === "reorder") return msg("history.reordered", "Reordered");
    return msg("history.saved", "Saved");
  }

  var HISTORY_SHOWN_CHANGES = 4;

  /**
   * One change: "Intro label  Studio of two → A studio of two people".
   * @param {import('./studio/history-view.js').HistoryChange} change
   */
  function historyChangeItem(change) {
    var item = document.createElement("li");
    var label = document.createElement("span");
    label.className = "caret-history-field";
    label.textContent = change.label;
    var before = document.createElement("del");
    before.textContent = change.before;
    var arrow = document.createElement("span");
    arrow.className = "caret-history-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    var after = document.createElement("ins");
    after.textContent = change.after;
    item.appendChild(label);
    if (change.diff) {
      // Text that was edited, not rewritten: the changed words in place.
      var words = document.createElement("span");
      words.className = "caret-history-words";
      change.diff.forEach(function (part) {
        if (part.op === "=") { words.appendChild(document.createTextNode(part.text)); return; }
        var mark = document.createElement(part.op === "-" ? "del" : "ins");
        mark.textContent = part.text;
        words.appendChild(mark);
      });
      item.appendChild(words);
      return item;
    }
    item.appendChild(before);
    item.appendChild(arrow);
    item.appendChild(after);
    return item;
  }

  function loadHistory() {
    var moreMenu = document.getElementById("entry-more");
    if (moreMenu) moreMenu.removeAttribute("open");
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
      // Each snapshot is the entry as it was before a change. What the change
      // made is the next newer snapshot, or the saved entry for the newest.
      var saved = /** @type {Record<string, unknown>} */ (JSON.parse(originalJson || "{}"));
      var now = Date.now();
      var empty = msg("history.empty", "Empty");
      items.forEach(function (item, index) {
        var afterChange = index === 0 ? saved : items[index - 1].data;
        var row = document.createElement("div");
        row.className = "caret-history-row";
        var fullTime = new Date(item.ts).toLocaleString(document.documentElement.lang || undefined);
        var when = relativeTime(item.ts, now, document.documentElement.lang || undefined);

        var summary = document.createElement("div");
        summary.className = "caret-history-summary";
        var info = document.createElement("div");
        info.className = "caret-history-meta";

        var actionSpan = document.createElement("span");
        actionSpan.className = "caret-history-action";
        actionSpan.dataset.action = item.action || "save";
        actionSpan.textContent = historyActionLabel(item.action || "save");

        var timeEl = document.createElement("time");
        timeEl.className = "caret-history-time";
        timeEl.dateTime = new Date(item.ts).toISOString();
        timeEl.title = fullTime;
        timeEl.textContent = when;

        info.appendChild(actionSpan);
        info.appendChild(timeEl);
        if (item.editor && typeof item.editor.id === "string") {
          var editorSpan = document.createElement("span");
          editorSpan.className = "caret-history-editor";
          editorSpan.textContent = item.editor.name || item.editor.email
            // Password sessions carry only an id, renewed at each sign-in, so a
            // different id is an earlier session, not necessarily another person.
            || (item.editor.current ? msg("history.you", "You") : msg("history.otherSession", "Earlier session"));
          editorSpan.title = item.editor.id;
          info.appendChild(editorSpan);
        }
        summary.appendChild(info);

        var changes = item.data ? historyChanges(item.data, afterChange, entrySchema, empty) : [];
        if (changes.length === 0) {
          var none = document.createElement("p");
          none.className = "caret-history-changes";
          none.textContent = msg("history.noFieldChanges", "No field changes");
          summary.appendChild(none);
        } else {
          var list = document.createElement("ul");
          list.className = "caret-history-diff";
          changes.slice(0, HISTORY_SHOWN_CHANGES).forEach(function (change) { list.appendChild(historyChangeItem(change)); });
          summary.appendChild(list);
          if (changes.length > HISTORY_SHOWN_CHANGES) {
            var more = document.createElement("details");
            more.className = "caret-history-more";
            var moreSummary = document.createElement("summary");
            var hidden = changes.length - HISTORY_SHOWN_CHANGES;
            moreSummary.textContent = msg(hidden === 1 ? "history.moreChangesOne" : "history.moreChanges", "{count} more changes").replace("{count}", String(hidden));
            var moreList = document.createElement("ul");
            moreList.className = "caret-history-diff";
            changes.slice(HISTORY_SHOWN_CHANGES).forEach(function (change) { moreList.appendChild(historyChangeItem(change)); });
            more.appendChild(moreSummary);
            more.appendChild(moreList);
            summary.appendChild(more);
          }
        }
        row.appendChild(summary);

        var restoreBtn = document.createElement("button");
        restoreBtn.type = "button";
        restoreBtn.className = "studio-btn-ghost";
        restoreBtn.textContent = msg("history.restoreBefore", "Restore earlier version");
        restoreBtn.setAttribute("aria-label", msg("history.restoreBeforeLabel", "Restore the version from before the change {time}").replace("{time}", when));
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
    historyBtn.focus();
  }

  /** @param {number} ts */
  async function restoreSnapshot(ts) {
    if (!(await confirmAction({
      title: msg("entry.restoreTitle", "Go back to before this change?"),
      copy: msg("entry.restoreCopy", "The fields return to how they were before this change, which also undoes any later changes. The current version stays in History, so you can come back to it."),
      action: msg("entry.restore", "Restore"),
    }))) return;
    historyClient.restore({ collection: COLLECTION, id: ID, ts: ts }).then(function (result) {
      if (result.kind === "unauthorized") { loginRedirect(); return; }
      if (result.kind === "error") {
        showStatus("error", result.message || "Restore failed");
        return;
      }
      var prevData = entryData;
      var prevJson = originalJson;
      try {
        if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
          throw new Error("invalid restored entry data");
        }
        entryData = fillDefaults(deepClone(/** @type {Record<string, unknown>} */ (result.data)), entrySchema);
        originalJson = JSON.stringify(entryData);
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
  if (publishBtn) publishBtn.addEventListener("click", publishEntry);
  if (discardDraftBtn) discardDraftBtn.addEventListener("click", discardEntryDraft);
  // With an authorization policy, Publish appears only for editors allowed to publish.
  if (publishBtn) {
    fetch(API + "/draft", { headers: { "x-caret-request": "1" }, credentials: "same-origin" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) {
        if (body && body.canPublish === false) { canPublish = false; updateDraftUi(); }
      }).catch(function () {});
  }
  historyBtn.addEventListener("click", loadHistory);
  // More actions closes on Esc (focus back on its button) and when focus leaves it.
  var moreMenuEl = document.getElementById("entry-more");
  if (moreMenuEl instanceof HTMLDetailsElement) {
    var moreMenu = moreMenuEl;
    moreMenu.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !moreMenu.open) return;
      event.preventDefault();
      event.stopPropagation();
      moreMenu.open = false;
      var summary = moreMenu.querySelector("summary");
      if (summary instanceof HTMLElement) summary.focus();
    });
    moreMenu.addEventListener("focusout", function (event) {
      var next = event.relatedTarget;
      if (moreMenu.open && next instanceof Node && !moreMenu.contains(next)) moreMenu.open = false;
    });
  }
  // The ⌘K palette offers this entry's history.
  var studioWindow = /** @type {Window & { caretStudioActions?: Array<{ label: string, keywords: string, run: () => void }> }} */ (window);
  (studioWindow.caretStudioActions = studioWindow.caretStudioActions || []).push({
    label: msg("entry.versionHistory", "Version history"),
    keywords: "history versions revisions restore",
    run: function () { if (!creating && !historyBtn.hidden) loadHistory(); },
  });
  historyCloseBtn.addEventListener("click", closeHistoryPanel);

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
    if (e.key === "Escape" && !historyPanel.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeHistoryPanel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
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
          // The on-page drawer opens entries the page shows, which may not be
          // stored until their first edit.
          var notFoundText = notFoundEl.querySelector("p");
          if (window.parent !== window && notFoundText) notFoundText.textContent = msg("entry.notSavedYet", "Nothing is saved for this content yet. Edit it on the page and it will show up here.");
          notFoundEl.hidden = false;
          return;
        }
        var initialData = result.data;
        entryData = fillDefaults(deepClone(initialData), entrySchema);
        entryRevision = result.revision;
        entryBaseRevision = result.baseRevision;
        liveData = result.live;
        if (IS_NEW && result.initialized) {
          creating = true;
          blankRequiredText(entryData, entrySchema);
          var givenTitle = new URLSearchParams(window.location.search).get("title");
          if (CFG.titleField && givenTitle) setNestedValue(entryData, CFG.titleField, givenTitle);
          if (publicationFieldName) setNestedValue(entryData, publicationFieldName, false);
        }
        originalJson = JSON.stringify(entryData);
        updateDisplayedTitle();
        renderFields(fieldsEl, entryData, entrySchema, "");
        if (validationWarningEl && result.validationIssues.length > 0) {
          validationWarningEl.textContent = "This stored entry has invalid fields: " + result.validationIssues.map(function (issue) {
            return (issue.path || "entry") + " — " + issue.message;
          }).join("; ") + ". Correct them and Save to restore public delivery.";
          validationWarningEl.hidden = false;
        }
        updateSaveButton();
        editorEl.hidden = false;
        studioSync.announceReady();
        // The toolbar's History link opens the entry with #history (a reload,
        // or only a hash change when the drawer already shows this entry).
        var openHistoryFromHash = function () {
          if (window.location.hash === "#history" && !creating && !historyBtn.hidden && historyPanel.hidden) loadHistory();
        };
        openHistoryFromHash();
        window.addEventListener("hashchange", openHistoryFromHash);
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
