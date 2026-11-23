/**
 * Point Git at the repo's `.githooks` directory inside a real local clone or
 * worktree, and no-op everywhere else (GitHub tarballs, Windows cmd.exe, or a
 * copy nested inside another Git repository).
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync(".git") && existsSync(".githooks")) {
  spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    stdio: "ignore",
  });
}
