/**
 * @caretcms/caretize — public entry.
 *
 * v0.1 surfaces the byte-correct splice/parse core. Detection, naming, the
 * interactive review loop, and the CLI build on top of these primitives.
 */

export {
  parseAstro,
  walkTags,
  isTagNode,
  tagElementAndVerify,
  type AstroNode,
  type TagNode,
  type ContainerNode,
  type TagResult,
} from "./parse.js";

export {
  findOpenTagEnd,
  spliceAttribute,
  type OpenTagEnd,
} from "./splice.js";
