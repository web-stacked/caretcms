/**
 * Three-way merge for Studio save conflicts.
 *
 * `base` is the entry the form loaded, `mine` is the form, and `theirs` is the
 * newer saved entry. Plain objects merge field by field; arrays and other
 * values are replaced whole, because list items have no stable identity.
 */

/** @typedef {Record<string, unknown>} Data */

/** @param {unknown} value @returns {value is Data} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} a @param {unknown} b */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Dot paths of the leaves that differ between two values.
 * @param {unknown} from @param {unknown} to @param {string} [prefix]
 * @returns {string[]}
 */
export function changedPaths(from, to, prefix = '') {
  if (same(from, to)) return [];
  if (!isPlainObject(from) || !isPlainObject(to)) return [prefix];
  /** @type {string[]} */
  const paths = [];
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    paths.push(...changedPaths(from[key], to[key], prefix ? `${prefix}.${key}` : key));
  }
  return paths;
}

/** @param {Data} target @param {string} path @param {unknown} value @param {boolean} present */
function assign(target, path, value, present) {
  const keys = path.split('.');
  /** @type {Data} */
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = /** @type {Data} */ (node[key]);
  }
  const last = /** @type {string} */ (keys[keys.length - 1]);
  if (present) node[last] = structuredClone(value);
  else delete node[last];
}

/** @param {unknown} data @param {string} path */
function lookup(data, path) {
  /** @type {unknown} */
  let node = data;
  for (const key of path.split('.')) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, key)) return { present: false, value: undefined };
    node = node[key];
  }
  return { present: true, value: node };
}

/**
 * Applies the form's own edits on top of the newer saved entry.
 * @param {Data} base @param {Data} mine @param {Data} theirs
 * @returns {{ merged: Data, theirChanges: string[], overlapping: string[] }}
 */
export function rebaseEdits(base, mine, theirs) {
  const myChanges = changedPaths(base, mine);
  const theirChanges = changedPaths(base, theirs);
  const merged = /** @type {Data} */ (structuredClone(theirs));
  for (const path of myChanges) {
    const { present, value } = lookup(mine, path);
    assign(merged, path, value, present);
  }
  const overlapping = theirChanges.filter(path => myChanges.some(mineAt =>
    mineAt === path || mineAt.startsWith(`${path}.`) || path.startsWith(`${mineAt}.`))
    && !same(lookup(mine, path).value, lookup(theirs, path).value));
  return { merged, theirChanges, overlapping };
}
