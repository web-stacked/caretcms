/**
 * @caretcms/caretize — public entry.
 *
 * v0.1 surfaces the byte-correct splice/parse core plus detection, naming, and
 * planning. The interactive review loop and the CLI build on top of these.
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

export {
  detect,
  type Candidate,
  type Skipped,
  type SkipReason,
  type Confidence,
  type CandidateKind,
  type IteratorFlag,
  type DetectResult,
} from "./detect.js";

export {
  deriveScope,
  assignFields,
  slugifyText,
  isValidCollection,
  isValidId,
  isValidField,
  type Scope,
  type ScopeReason,
  type ScopeResult,
} from "./name.js";

export { applyTags, type TagInsertion, type ApplyResult } from "./write.js";

export {
  planFile,
  type PlannedTag,
  type FilePlan,
  type PlanOptions,
} from "./plan.js";

export {
  wrapConst,
  detectWrapTargetsSafe,
  type WrapResult,
  type WrapCandidate,
  type WrapTarget,
  type WrapOrigin,
} from "./wrap.js";

export {
  wrapImport,
  detectImportWrapCandidates,
  detectImportWrapTargetsSafe,
  type ImportWrapCandidate,
} from "./import-wrap.js";

export {
  importBindingNames,
  literalConstNames,
  type ImportKind,
} from "./frontmatter.js";

export { detectPropWrapTargets, childRendersPropAsText, type FileReader } from "./props.js";

export {
  detectPropHoistTargets,
  hoistPropLiterals,
  verifyHoistResult,
  type PropHoistTarget,
  type HoistProp,
  type HoistResult,
} from "./prop-hoist.js";
