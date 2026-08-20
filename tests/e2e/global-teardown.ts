import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resetCmsStorage } from "./helpers";

/** Stop the background dev server started in global-setup. Runs even after
 *  failures, so the Astro 7 daemon never leaks past the run. */
const starterCwd = fileURLToPath(new URL("../../examples/starter/", import.meta.url));

export default async function globalTeardown(): Promise<void> {
  try {
    execFileSync("npx", ["astro", "dev", "stop"], { cwd: starterCwd, stdio: "ignore" });
  } catch {
    /* already stopped */
  }
  resetCmsStorage();
}
