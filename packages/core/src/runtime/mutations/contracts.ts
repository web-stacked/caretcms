import type { StorageAdapter } from "../../types.js";

export type MutationIssue = {
  path: string;
  code: string;
  message: string;
};

export type SaveFieldCommand = {
  type: "save_field";
  collection: string;
  id: string;
  field: string;
  value: string;
  expectedRevision?: number;
};

export type PutEntryCommand = {
  type: "put_entry";
  collection: string;
  id: string;
  data: Record<string, unknown>;
  expectedRevision?: number;
};

export type DeleteEntryCommand = {
  type: "delete_entry";
  collection: string;
  id: string;
  expectedRevision?: number;
};

export type ReorderEntriesCommand = {
  type: "reorder_entries";
  collection: string;
  items: Array<{
    id: string;
    order: number;
    expectedRevision?: number;
  }>;
};

export type UpdatePageLayoutCommand = {
  type: "update_page_layout";
  collection: string;
  id: string;
  sections: Array<{
    id: string;
    key: string;
    enabled: boolean;
    spacing_y?: string;
  }>;
  expectedRevision?: number;
};

export type CreateCollectionCommand = {
  type: "create_collection";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  creatable?: boolean;
  orderable?: boolean;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    title?: string;
    description?: string;
  };
};

export type DeleteCollectionCommand = {
  type: "delete_collection";
  id: string;
};

export type CmsMutationCommand =
  | SaveFieldCommand
  | PutEntryCommand
  | DeleteEntryCommand
  | ReorderEntriesCommand
  | UpdatePageLayoutCommand
  | CreateCollectionCommand
  | DeleteCollectionCommand;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalExpectedRevision(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return null;
}

const COLLECTION_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Validate a collection name's *format* (not its existence). A well-formed
 * name is accepted even for a collection that has never been written — writes
 * auto-create collections (FR-8), and reads of a not-yet-created collection
 * are legitimate (the template is the source of truth until the first edit).
 */
export function parseCollectionName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return COLLECTION_NAME_RE.test(normalized) ? normalized : null;
}

function parseCollection(_adapter: StorageAdapter, value: unknown): string | null {
  return parseCollectionName(value);
}

/**
 * Validate an entry id as a filesystem-safe slug. Blocks `..`, `/`, `\`,
 * leading `.`, and any character outside `[a-z0-9_-]`. Critical: prevents
 * path traversal in adapters that use the id as a filename.
 */
export function parseEntryId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return ENTRY_ID_RE.test(normalized) ? normalized : null;
}

function issue(path: string, code: string, message: string): MutationIssue {
  return { path, code, message };
}

async function parseSaveFieldCommand(
  adapter: StorageAdapter,
  input: Record<string, unknown>,
): Promise<{ ok: true; command: SaveFieldCommand } | { ok: false; issues: MutationIssue[] }> {
  const issues: MutationIssue[] = [];
  const collection = await parseCollection(adapter, input.collection);
  const id = parseEntryId(input.id);
  const field = asNonEmptyString(input.field);
  const value = input.value;
  const expectedRevision = asOptionalExpectedRevision(input.expectedRevision);

  if (!collection) issues.push(issue("collection", "invalid_type", "Invalid collection"));
  if (!id) issues.push(issue("id", "invalid_type", "Invalid id"));
  if (!field) issues.push(issue("field", "invalid_type", "Invalid field path"));
  if (typeof value !== "string") issues.push(issue("value", "invalid_type", "Value must be a string"));
  if (expectedRevision === null) {
    issues.push(issue("expectedRevision", "invalid_type", "expectedRevision must be a non-negative integer"));
  }

  if (issues.length > 0 || !collection || !id || !field || typeof value !== "string") {
    return { ok: false, issues };
  }

  return {
    ok: true,
    command: {
      type: "save_field",
      collection,
      id,
      field,
      value,
      expectedRevision: expectedRevision ?? undefined,
    },
  };
}

async function parsePutEntryCommand(
  adapter: StorageAdapter,
  input: Record<string, unknown>,
): Promise<{ ok: true; command: PutEntryCommand } | { ok: false; issues: MutationIssue[] }> {
  const issues: MutationIssue[] = [];
  const collection = await parseCollection(adapter, input.collection);
  const id = parseEntryId(input.id);
  const data = input.data;
  const expectedRevision = asOptionalExpectedRevision(input.expectedRevision);

  if (!collection) issues.push(issue("collection", "invalid_type", "Invalid collection"));
  if (!id) issues.push(issue("id", "invalid_type", "Invalid id"));
  if (!isRecord(data)) issues.push(issue("data", "invalid_type", "data must be an object"));
  if (expectedRevision === null) {
    issues.push(issue("expectedRevision", "invalid_type", "expectedRevision must be a non-negative integer"));
  }

  if (issues.length > 0 || !collection || !id || !isRecord(data)) return { ok: false, issues };

  return {
    ok: true,
    command: {
      type: "put_entry",
      collection,
      id,
      data,
      expectedRevision: expectedRevision ?? undefined,
    },
  };
}

async function parseDeleteEntryCommand(
  adapter: StorageAdapter,
  input: Record<string, unknown>,
): Promise<{ ok: true; command: DeleteEntryCommand } | { ok: false; issues: MutationIssue[] }> {
  const issues: MutationIssue[] = [];
  const collection = await parseCollection(adapter, input.collection);
  const id = parseEntryId(input.id);
  const expectedRevision = asOptionalExpectedRevision(input.expectedRevision);

  if (!collection) issues.push(issue("collection", "invalid_type", "Invalid collection"));
  if (!id) issues.push(issue("id", "invalid_type", "Invalid id"));
  if (expectedRevision === null) {
    issues.push(issue("expectedRevision", "invalid_type", "expectedRevision must be a non-negative integer"));
  }

  if (issues.length > 0 || !collection || !id) return { ok: false, issues };

  return {
    ok: true,
    command: {
      type: "delete_entry",
      collection,
      id,
      expectedRevision: expectedRevision ?? undefined,
    },
  };
}

async function parseReorderEntriesCommand(
  adapter: StorageAdapter,
  input: Record<string, unknown>,
): Promise<{ ok: true; command: ReorderEntriesCommand } | { ok: false; issues: MutationIssue[] }> {
  const issues: MutationIssue[] = [];
  const collection = await parseCollection(adapter, input.collection);
  if (!collection) {
    issues.push(issue("collection", "invalid_type", "Invalid collection"));
  }

  const rawItems = input.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    issues.push(issue("items", "invalid_type", "Items must be a non-empty array"));
    return { ok: false, issues };
  }

  const items: ReorderEntriesCommand["items"] = [];
  rawItems.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(issue(`items.${index}`, "invalid_type", "Item must be an object"));
      return;
    }
    const id = parseEntryId(item.id);
    const order = item.order;
    const expectedRevision = asOptionalExpectedRevision(item.expectedRevision);

    if (!id) issues.push(issue(`items.${index}.id`, "invalid_type", "Invalid id"));
    if (!(typeof order === "number" && Number.isInteger(order) && order >= 0)) {
      issues.push(issue(`items.${index}.order`, "invalid_type", "order must be a non-negative integer"));
    }
    if (expectedRevision === null) {
      issues.push(issue(`items.${index}.expectedRevision`, "invalid_type", "expectedRevision must be a non-negative integer"));
    }

    if (id && typeof order === "number" && Number.isInteger(order) && order >= 0) {
      items.push({
        id,
        order,
        expectedRevision: expectedRevision ?? undefined,
      });
    }
  });

  if (issues.length > 0 || !collection) return { ok: false, issues };
  return { ok: true, command: { type: "reorder_entries", collection, items } };
}

async function parseUpdatePageLayoutCommand(
  adapter: StorageAdapter,
  input: Record<string, unknown>,
): Promise<{ ok: true; command: UpdatePageLayoutCommand } | { ok: false; issues: MutationIssue[] }> {
  const issues: MutationIssue[] = [];
  const collection = await parseCollection(adapter, input.collection ?? "pages");
  const id = parseEntryId(input.id);
  const expectedRevision = asOptionalExpectedRevision(input.expectedRevision);
  const rawSections = input.sections;

  if (!collection) issues.push(issue("collection", "invalid_type", "Invalid collection"));
  if (!id) issues.push(issue("id", "invalid_type", "Invalid id"));
  if (expectedRevision === null) {
    issues.push(issue("expectedRevision", "invalid_type", "expectedRevision must be a non-negative integer"));
  }
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    issues.push(issue("sections", "invalid_type", "Sections must be a non-empty array"));
    return { ok: false, issues };
  }

  const sections: UpdatePageLayoutCommand["sections"] = [];
  rawSections.forEach((section, index) => {
    if (!isRecord(section)) {
      issues.push(issue(`sections.${index}`, "invalid_type", "Section must be an object"));
      return;
    }
    const sectionId = asNonEmptyString(section.id);
    const key = asNonEmptyString(section.key);
    const enabled = section.enabled;
    const spacing = section.spacing_y;

    if (!sectionId) issues.push(issue(`sections.${index}.id`, "invalid_type", "Invalid section id"));
    if (!key) issues.push(issue(`sections.${index}.key`, "invalid_type", "Invalid section key"));
    if (!(enabled === undefined || typeof enabled === "boolean")) {
      issues.push(issue(`sections.${index}.enabled`, "invalid_type", "enabled must be boolean"));
    }
    if (!(spacing === undefined || typeof spacing === "string")) {
      issues.push(issue(`sections.${index}.spacing_y`, "invalid_type", "spacing_y must be a string"));
    }

    if (sectionId && key) {
      sections.push({
        id: sectionId,
        key,
        enabled: typeof enabled === "boolean" ? enabled : true,
        spacing_y: typeof spacing === "string" ? spacing : undefined,
      });
    }
  });

  if (issues.length > 0 || !id || !collection) return { ok: false, issues };

  return {
    ok: true,
    command: {
      type: "update_page_layout",
      collection,
      id,
      sections,
      expectedRevision: expectedRevision ?? undefined,
    },
  };
}

export async function parseMutationCommand(
  adapter: StorageAdapter,
  input: unknown,
): Promise<{ ok: true; command: CmsMutationCommand } | { ok: false; issues: MutationIssue[] }> {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [issue("", "invalid_type", "Mutation payload must be an object")],
    };
  }

  const type = asNonEmptyString(input.type);
  if (!type) {
    return {
      ok: false,
      issues: [issue("type", "invalid_type", "Missing mutation type")],
    };
  }

  switch (type) {
    case "save_field":
      return parseSaveFieldCommand(adapter, input);
    case "put_entry":
      return parsePutEntryCommand(adapter, input);
    case "delete_entry":
      return parseDeleteEntryCommand(adapter, input);
    case "reorder_entries":
      return parseReorderEntriesCommand(adapter, input);
    case "update_page_layout":
      return parseUpdatePageLayoutCommand(adapter, input);
    case "create_collection":
      return parseCreateCollectionCommand(adapter, input);
    case "delete_collection":
      return parseDeleteCollectionCommand(adapter, input);
    default:
      return {
        ok: false,
        issues: [issue("type", "invalid_enum_value", `Unsupported mutation type "${type}"`)],
      };
  }
}

async function parseCreateCollectionCommand(
  _adapter: StorageAdapter,
  input: Record<string, unknown>,
): Promise<{ ok: true; command: CreateCollectionCommand } | { ok: false; issues: MutationIssue[] }> {
  const issues: MutationIssue[] = [];
  const id = asNonEmptyString(input.id);
  const label = asNonEmptyString(input.label);
  const description = typeof input.description === "string" ? input.description : undefined;
  const icon = typeof input.icon === "string" ? input.icon : undefined;
  const creatable = typeof input.creatable === "boolean" ? input.creatable : undefined;
  const orderable = typeof input.orderable === "boolean" ? input.orderable : undefined;
  const schema = input.schema;

  if (!id || !/^[a-z][a-z0-9_-]*$/.test(id)) {
    issues.push(issue("id", "invalid_type", "Collection ID must be lowercase alphanumeric with hyphens/underscores"));
  }
  if (!label) {
    issues.push(issue("label", "invalid_type", "Label is required"));
  }
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
    issues.push(issue("schema", "invalid_type", "Schema must be a valid JSON Schema object with properties"));
  }

  if (issues.length > 0 || !id || !label || !isRecord(schema)) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    command: {
      type: "create_collection",
      id,
      label,
      description,
      icon,
      creatable,
      orderable,
      schema: schema as CreateCollectionCommand["schema"],
    },
  };
}

async function parseDeleteCollectionCommand(
  adapter: StorageAdapter,
  input: Record<string, unknown>,
): Promise<{ ok: true; command: DeleteCollectionCommand } | { ok: false; issues: MutationIssue[] }> {
  const issues: MutationIssue[] = [];
  const id = await parseCollection(adapter, input.id);

  if (!id) {
    issues.push(issue("id", "invalid_type", "Collection ID must be lowercase alphanumeric with hyphens/underscores"));
  }

  if (issues.length > 0 || !id) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    command: {
      type: "delete_collection",
      id,
    },
  };
}
