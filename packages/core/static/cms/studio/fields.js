/** Studio field rendering. Persistence and specialized widgets are injected. */
import { fieldIdFromPath, humanizeKey, templateFromSchema } from './field-model.js';
import { sanitizeHtml } from '../editor/sanitize.js';
/** @typedef {import('./field-model.js').Schema} Schema */
/** @typedef {Record<string, unknown>} Entry */

/** @param {string} label @param {boolean} isRequired @param {boolean} [inline] */
export function createFieldGroup(label, isRequired, inline) {
  var wrapper = document.createElement("div");
  wrapper.className = "caret-field-group" + (inline ? " caret-field-inline" : "");

  var labelEl = document.createElement("label");
  labelEl.className = "studio-label";
  labelEl.textContent = label;
  if (isRequired === true) {
    var marker = document.createElement("span");
    marker.className = "caret-required-marker";
    marker.textContent = " *";
    marker.setAttribute("aria-hidden", "true");
    labelEl.appendChild(marker);
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
    var control = Array.from(/** @type {NodeListOf<HTMLElement>} */ (wrapper.querySelectorAll("input, select, textarea, button[role='switch'], [contenteditable='true']"))).find(function (candidate) {
      return candidate.closest(".caret-field-group") === wrapper;
    });
    if (!control) return;
    var fid = fieldIdFromPath(path);
    control.id = fid;
    if ("name" in control) control.name = path;
    labelEl.id = fid + "-label";
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
      labelEl.htmlFor = control.id;
    } else {
      control.setAttribute("aria-labelledby", labelEl.id);
    }
    if (isRequired === true) control.setAttribute("aria-required", "true");
    var help = wrapper.querySelector(".caret-field-description");
    if (help && help.id) control.setAttribute("aria-describedby", help.id);
  });

  return wrapper;
}

/**
 * @param {{
 * updateField: (path: string, value: unknown) => void,
 * buildSingleImage: (value: unknown, path: string) => HTMLElement,
 * buildImageGallery: (value: unknown, path: string) => HTMLElement,
 * buildObjectArray: (value: unknown, path: string, schema: Schema | null) => HTMLElement,
 * buildTagList: (value: unknown, path: string) => HTMLElement,
 * getPublicationField: () => string | null,
 * getMessage: (key: string, fallback: string) => string
 * }} dependencies
 */
export function createFieldRenderer({ updateField, buildSingleImage, buildImageGallery, buildObjectArray, buildTagList, getPublicationField, getMessage }) {
  /** @param {HTMLElement} group @param {Schema} prop @param {string} path */
  function appendFieldDescription(group, prop, path) {
    if (typeof prop.description !== "string" || !prop.description.trim()) return;
    var help = document.createElement("p");
    help.className = "caret-field-help caret-field-description";
    help.id = fieldIdFromPath(path) + "-help";
    help.textContent = prop.description.trim();
    group.appendChild(help);
  }

  /** @param {unknown} value @param {string} path @returns {HTMLElement} */
  function buildRichField(value, path) {
    var wrapper = document.createElement("div");
    wrapper.className = "caret-rich-field";

    var toolbar = document.createElement("div");
    toolbar.className = "caret-rich-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", getMessage("field.formatting", "Text formatting"));

    var editor = document.createElement("div");
    editor.className = "studio-input caret-rich-editor";
    editor.contentEditable = "true";
    editor.setAttribute("name", path);
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-multiline", "true");
    editor.innerHTML = sanitizeHtml(String(value || ""));

    var source = document.createElement("textarea");
    source.className = "studio-input caret-rich-source";
    source.rows = 6;
    source.hidden = true;
    source.value = editor.innerHTML;
    source.setAttribute("aria-label", getMessage("field.htmlSource", "HTML source"));

    /** @param {string} command @param {string} label @param {string} text */
    function addCommand(command, label, text) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "caret-rich-command";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.textContent = text;
      button.addEventListener("mousedown", function (event) { event.preventDefault(); });
      button.addEventListener("click", function () {
        editor.focus();
        document.execCommand(command, false);
        updateField(path, sanitizeHtml(editor.innerHTML));
      });
      toolbar.appendChild(button);
    }

    addCommand("bold", getMessage("field.bold", "Bold"), "B");
    addCommand("italic", getMessage("field.italic", "Italic"), "I");

    var linkButton = document.createElement("button");
    linkButton.type = "button";
    linkButton.className = "caret-rich-command";
    linkButton.textContent = getMessage("field.link", "Link");
    linkButton.addEventListener("mousedown", function (event) { event.preventDefault(); });
    linkButton.addEventListener("click", function () {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        editor.focus();
        return;
      }
      var href = window.prompt(getMessage("field.linkPrompt", "Link URL"), "https://");
      if (href === null) return;
      if (!href.trim()) document.execCommand("unlink", false);
      else document.execCommand("createLink", false, href.trim());
      editor.innerHTML = sanitizeHtml(editor.innerHTML);
      updateField(path, editor.innerHTML);
      editor.focus();
    });
    toolbar.appendChild(linkButton);

    var sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.className = "caret-rich-source-toggle";
    sourceButton.textContent = getMessage("field.editHtml", "Edit HTML");
    sourceButton.setAttribute("aria-expanded", "false");
    sourceButton.addEventListener("click", function () {
      var showingSource = source.hidden;
      if (showingSource) {
        source.value = sanitizeHtml(editor.innerHTML);
        editor.hidden = true;
        source.hidden = false;
        sourceButton.textContent = getMessage("field.showFormatted", "Show formatted");
        sourceButton.setAttribute("aria-expanded", "true");
        source.focus();
      } else {
        editor.innerHTML = sanitizeHtml(source.value);
        source.hidden = true;
        editor.hidden = false;
        sourceButton.textContent = getMessage("field.editHtml", "Edit HTML");
        sourceButton.setAttribute("aria-expanded", "false");
        editor.focus();
      }
    });
    toolbar.appendChild(sourceButton);

    editor.addEventListener("input", function () {
      updateField(path, sanitizeHtml(editor.innerHTML));
    });
    editor.addEventListener("blur", function () {
      editor.innerHTML = sanitizeHtml(editor.innerHTML);
    });
    editor.addEventListener("paste", function (event) {
      var html = event.clipboardData?.getData("text/html");
      if (!html) return;
      event.preventDefault();
      document.execCommand("insertHTML", false, sanitizeHtml(html));
    });
    source.addEventListener("input", function () {
      updateField(path, sanitizeHtml(source.value));
    });

    wrapper.appendChild(toolbar);
    wrapper.appendChild(editor);
    wrapper.appendChild(source);
    return wrapper;
  }

  /** @param {Schema | null} schema @returns {boolean} */
  function schemaHasRequiredField(schema) {
    if (!schema || typeof schema !== "object") return false;
    if (Array.isArray(schema.required) && schema.required.length > 0) return true;
    if (schema.properties) {
      return Object.values(schema.properties).some(function (property) {
        return schemaHasRequiredField(property);
      });
    }
    return schema.items ? schemaHasRequiredField(schema.items) : false;
  }

  /* ─── Schema-driven rendering ───────────────────────────────────── */
  /** @param {HTMLElement} container @param {Entry | null} data @param {Schema | null} schema @param {string} basePath */
  function renderFields(container, data, schema, basePath) {
    if (!schema || !schema.properties) {
      renderFieldsFallback(container, data, basePath);
      return;
    }

    if (!basePath && schemaHasRequiredField(schema)) {
      var requiredNote = document.createElement("p");
      requiredNote.className = "caret-required-note";
      requiredNote.textContent = getMessage("field.requiredNote", "Fields marked * are required.");
      container.appendChild(requiredNote);
    }

    var required = new Set(schema.required || []);

    /** @type {Map<string, HTMLElement>} */
    var groupedTargets = new Map();
    var ungroupedTarget = container;
    var configuredGroups = Array.isArray(schema["x-caret-groups"])
      ? schema["x-caret-groups"].filter(function (item) { return item && typeof item === "object" && Array.isArray(item.fields); })
      : [];
    if (configuredGroups.length) {
      configuredGroups.forEach(function (item) {
        var section = document.createElement("section");
        section.className = "caret-field-section";
        var title = document.createElement("h2");
        title.className = "caret-field-section-title";
        title.textContent = String(item.title || item.label || getMessage("field.group", "Fields"));
        section.appendChild(title);
        if (typeof item.description === "string" && item.description.trim()) {
          var description = document.createElement("p");
          description.className = "caret-field-section-description";
          description.textContent = item.description.trim();
          section.appendChild(description);
        }
        var body = document.createElement("div");
        body.className = "caret-field-section-body";
        section.appendChild(body);
        item.fields.forEach(function (/** @type {unknown} */ key) {
          if (typeof key === "string") groupedTargets.set(key, body);
        });
        container.appendChild(section);
      });
      ungroupedTarget = document.createElement("section");
      ungroupedTarget.className = "caret-field-section caret-field-section-ungrouped";
    }

    const properties = schema.properties;
    Object.keys(properties).forEach(function (key) {
      var prop = properties[key];
      var path = basePath ? basePath + "." + key : key;
      var label = String(prop.title || humanizeKey(key));
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
          option.value = String(opt);
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
      } else if (prop.type === "string" && prop.format === "html") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        group.appendChild(buildRichField(current, path));
      } else if (prop.type === "string" && prop.format === "textarea") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var ta = document.createElement("textarea");
        ta.className = "studio-input";
        ta.rows = 4;
        ta.value = String(current || "");
        ta.addEventListener("input", function () { updateField(path, ta.value); });
        group.appendChild(ta);
      } else if (prop.type === "string" && (prop.format === "email" || prop.format === "uri" || prop.format === "url")) {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var emailInput = document.createElement("input");
        emailInput.type = prop.format === "email" ? "email" : "url";
        emailInput.className = "studio-input";
        emailInput.value = String(current || "");
        emailInput.addEventListener("input", function () { updateField(path, emailInput.value); });
        group.appendChild(emailInput);
      } else if (prop.type === "string") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        /** @type {HTMLInputElement | HTMLTextAreaElement} */
        var input;
        if (typeof current === "string" && (current.length > 100 || /[\r\n]/.test(current))) {
          input = document.createElement("textarea");
          input.rows = 4;
        } else {
          input = document.createElement("input");
          input.type = "text";
        }
        input.className = "studio-input";
        input.value = String(current || "");
        input.addEventListener("input", function () { updateField(path, input.value); });
        group.appendChild(input);
      } else if (prop.type === "number" || prop.type === "integer") {
        group = createFieldGroup(label, isRequired);
        group.dataset.fieldPath = path;
        var num = document.createElement("input");
        num.type = "number";
        num.className = "studio-input";
        num.value = String(current == null ? 0 : current);
        if (prop.minimum !== undefined) num.min = String(prop.minimum);
        if (prop.maximum !== undefined) num.max = String(prop.maximum);
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
        if (path === getPublicationField()) {
          group.classList.add("caret-field-with-help");
          var publishHelp = document.createElement("p");
          publishHelp.className = "caret-field-help";
          publishHelp.textContent = current
            ? "Turn this off and Save to remove the entry from the public site without deleting it."
            : "Turn this on and Save when the entry is ready to appear on the public site.";
          toggle.addEventListener("click", function () {
            publishHelp.textContent = toggle.classList.contains("active")
              ? "Turn this off and Save to remove the entry from the public site without deleting it."
              : "Turn this on and Save when the entry is ready to appear on the public site.";
          });
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
        renderFields(nested, /** @type {Entry} */ (current || {}), prop, path);
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

      appendFieldDescription(group, prop, path);
      var target = groupedTargets.get(key) || ungroupedTarget;
      target.appendChild(group);
    });
    if (configuredGroups.length && ungroupedTarget.childElementCount > 0) {
      var fallbackTitle = document.createElement("h2");
      fallbackTitle.className = "caret-field-section-title";
      fallbackTitle.textContent = getMessage("field.otherFields", "Other fields");
      ungroupedTarget.insertBefore(fallbackTitle, ungroupedTarget.firstChild);
      container.appendChild(ungroupedTarget);
    }
  }

  /** @param {HTMLElement} container @param {Entry | null} data @param {string} basePath */
  function renderFieldsFallback(container, data, basePath) {
    if (!data || typeof data !== "object") return;
    Object.keys(data).forEach(function (key) {
      var value = data[key];
      var path = basePath ? basePath + "." + key : key;
      var label = humanizeKey(key);

      if (key === "images" && Array.isArray(value) && value.every(function (v) { return typeof v === "string"; })) {
        var g = createFieldGroup(label, false);
        g.dataset.fieldPath = path;
        g.appendChild(buildImageGallery(value, path));
        container.appendChild(g);
        return;
      }
      if ((key === "image" || key === "thumbnail" || key === "bg_image") && typeof value === "string") {
        var g2 = createFieldGroup(label, false);
        g2.dataset.fieldPath = path;
        g2.appendChild(buildSingleImage(value, path));
        container.appendChild(g2);
        return;
      }
      if (Array.isArray(value) && value.every(function (v) { return typeof v === "string"; })) {
        var g3 = createFieldGroup(label, false);
        g3.dataset.fieldPath = path;
        g3.appendChild(buildTagList(value, path));
        container.appendChild(g3);
        return;
      }
      if (Array.isArray(value) && value.every(function (v) { return typeof v === "object" && v !== null && !Array.isArray(v); })) {
        var g4 = createFieldGroup(label, false);
        g4.dataset.fieldPath = path;
        g4.appendChild(buildObjectArray(value, path, null));
        container.appendChild(g4);
        return;
      }
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        var g5 = createFieldGroup(label, false);
        g5.dataset.fieldPath = path;
        var nested = document.createElement("div");
        nested.className = "caret-nested";
        renderFieldsFallback(nested, /** @type {Entry} */ (value), path);
        g5.appendChild(nested);
        container.appendChild(g5);
        return;
      }
      if (typeof value === "boolean") {
        var g6 = createFieldGroup(label, false, true);
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
        var g7 = createFieldGroup(label, false);
        g7.dataset.fieldPath = path;
        var n = document.createElement("input");
        n.type = "number";
        n.className = "studio-input";
        n.value = String(value);
        n.addEventListener("input", function () { updateField(path, Number(n.value) || 0); });
        g7.appendChild(n);
        container.appendChild(g7);
        return;
      }
      if (typeof value === "string") {
        var g8 = createFieldGroup(label, false);
        g8.dataset.fieldPath = path;
        /** @type {HTMLInputElement | HTMLTextAreaElement} */
        var i;
        if (value.length > 100 || /[\r\n]/.test(value)) { i = document.createElement("textarea"); i.rows = 4; }
        else { i = document.createElement("input"); i.type = "text"; }
        i.className = "studio-input";
        i.value = value;
        i.addEventListener("input", function () { updateField(path, i.value); });
        g8.appendChild(i);
        container.appendChild(g8);
        return;
      }
      // Fallback to JSON
      var g9 = createFieldGroup(label, false);
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

  return { renderFields, renderFieldsFallback };
}
