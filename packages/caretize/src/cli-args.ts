/**
 * Argument parsing + help text for the caretize CLI. Pure and process-free: on a
 * bad flag it throws `CliUsageError` rather than calling process.exit, so the
 * parser is unit-testable and cli.ts owns the actual exit. Keeping this out of
 * cli.ts also keeps that file a thin orchestration shell.
 */

import type { Confidence } from "./detect.js";
import { isValidCollection, isValidId, type Scope } from "./name.js";

export interface Args {
  target?: string;
  dryRun: boolean;
  yes: boolean;
  minConfidence: Confidence;
  noImages: boolean;
  rich: boolean;
  noProps: boolean;
  bindCollections: boolean;
  bindRoutes: boolean;
  /** Turn on EVERY opt-in tier at once (collections + routes + rich + low
   *  confidence) — the one flag that replaces the four-flag incantation. */
  all: boolean;
  scope?: Scope;
  report?: string;
  restore: boolean;
  help: boolean;
  version: boolean;
}

/** Thrown on an invalid invocation; cli.ts maps it to a stderr message + exit 2. */
export class CliUsageError extends Error {}

export const HELP = `caretize · make an Astro project editable (data-caret + editable())

Usage: caretize [path] [options]

  path                     file or directory to scan (default: src/)
  --dry-run                print the plan, write nothing
  -y, --yes                auto-accept all suggestions at/above min-confidence
  --min-confidence <lvl>   high (default) | medium | low
  --no-images              skip <img> elements
  --no-props               skip hoisting static component-prop strings to editable()
  --bind-collections       bind getCollection().map() loops in place — a leaf
                           element rendering {item.data.field} gets a per-row
                           data-caret (direct-render only; props stay flagged)
  --bind-routes            bind a dynamic collection-detail route to the current
                           entry — a leaf rendering {entry.data.field} (entry from
                           getStaticPaths props) gets a data-caret instead of the
                           page being skipped as a dynamic route
  --rich                   also tag mixed-content blocks whose markup is
                           sanitizer-safe inline formatting (data-caret-rich)
  --all                    turn on every opt-in tier at once: --bind-collections,
                           --bind-routes, --rich, AND --min-confidence low. The
                           one-flag "make as much editable as possible" — includes
                           the low-confidence spots, so review the result
  --scope <collection::id> override the inferred scope
  --report <file>          write a JSON report
  --restore                restore the most recent backup, then exit
  -h, --help               show this help
  -v, --version            print version
`;

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false, yes: false, minConfidence: "high",
    noImages: false, rich: false, noProps: false, bindCollections: false,
    bindRoutes: false, all: false, restore: false, help: false, version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dry-run": a.dryRun = true; break;
      case "-y": case "--yes": a.yes = true; break;
      case "--no-images": a.noImages = true; break;
      case "--no-props": a.noProps = true; break;
      case "--bind-collections": a.bindCollections = true; break;
      case "--bind-routes": a.bindRoutes = true; break;
      case "--rich": a.rich = true; break;
      case "--all": case "--everything": a.all = true; break;
      case "--restore": a.restore = true; break;
      case "--help": case "-h": a.help = true; break;
      case "--version": case "-v": a.version = true; break;
      case "--min-confidence": {
        const v = argv[++i];
        if (v !== "high" && v !== "medium" && v !== "low") throw new CliUsageError(`--min-confidence must be high|medium|low`);
        a.minConfidence = v;
        break;
      }
      case "--scope": {
        const v = argv[++i] ?? "";
        const [collection, id] = v.split("::");
        if (!collection || !id) throw new CliUsageError(`--scope must be "collection::id"`);
        // The scope becomes a permanent storage key: a label the runtime
        // rejects would mint bindings that save but never render (and only
        // case-insensitive dev filesystems would mask it).
        if (!isValidCollection(collection)) {
          throw new CliUsageError(
            `--scope collection "${collection}" is invalid — must match ^[a-z][a-z0-9_-]*$`,
          );
        }
        if (!isValidId(id)) {
          throw new CliUsageError(
            `--scope id "${id}" is invalid — must match ^[a-z0-9][a-z0-9_-]*$`,
          );
        }
        a.scope = { collection, id };
        break;
      }
      case "--report": {
        const v = argv[++i];
        if (!v || v.startsWith("-")) {
          throw new CliUsageError(`--report needs a file path`);
        }
        a.report = v;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new CliUsageError(`unknown flag: ${arg}`);
        a.target = arg;
    }
  }
  return a;
}
