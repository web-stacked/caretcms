/** Studio field rendering. Persistence and specialized widgets are injected. */
import { fieldIdFromPath, humanizeKey, templateFromSchema } from './field-model.js';
/** @typedef {import('./field-model.js').Schema} Schema */
/** @typedef {Record<string, unknown>} Entry */

/** @param {string} label @param {boolean} isRequired @param {boolean} [inline] */
export function createFieldGroup(label, isRequired, inline) {
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
    var control = Array.from(/** @type {NodeListOf<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */ (wrapper.querySelectorAll("input, select, textarea"))).find(function (candidate) {
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

/**
 * @param {{
 * updateField: (path: string, value: unknown) => void,
 * buildSingleImage: (value: unknown, path: string) => HTMLElement,
 * buildImageGallery: (value: unknown, path: string) => HTMLElement,
 * buildObjectArray: (value: unknown, path: string, schema: Schema | null) => HTMLElement,
 * buildTagList: (value: unknown, path: string) => HTMLElement,
 * getPublicationField: () => string | null
 * }} dependencies
 */
export function createFieldRenderer({ updateField, buildSingleImage, buildImageGallery, buildObjectArray, buildTagList, getPublicationField }) {
  /* ─── Schema-driven rendering ───────────────────────────────────── */
  /** @param {HTMLElement} container @param {Entry | null} data @param {Schema | null} schema @param {string} basePath */
  function renderFields(container, data, schema, basePath) {
    if (!schema || !schema.properties) {
      renderFieldsFallback(container, data, basePath);
      return;
    }

    var required = new Set(schema.required || []);

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
      } else if (prop.type === "string" && (prop.format === "textarea" || prop.format === "html")) {
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

      container.appendChild(group);
    });
  }

  /** @param {HTMLElement} container @param {Entry | null} data @param {string} basePath */
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
        renderFieldsFallback(nested, /** @type {Entry} */ (value), path);
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
        n.value = String(value);
        n.addEventListener("input", function () { updateField(path, Number(n.value) || 0); });
        g7.appendChild(n);
        container.appendChild(g7);
        return;
      }
      if (typeof value === "string") {
        var g8 = createFieldGroup(label, true);
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

  return { renderFields, renderFieldsFallback };
}
