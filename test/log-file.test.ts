import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultLogFile } from "../src/log-file";

test("defaultLogFile uses the current working directory", () => {
  expect(defaultLogFile()).toBe(join(process.cwd(), "log", "symphony.log"));
});

test("defaultLogFile builds the log path under a custom root", () => {
  expect(defaultLogFile("/tmp/symphony-logs")).toBe("/tmp/symphony-logs/log/symphony.log");
});
