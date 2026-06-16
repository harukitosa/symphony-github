import { join } from "node:path";
import { cwd } from "node:process";

export function defaultLogFile(root = cwd()): string {
  return join(root, "log", "symphony.log");
}
