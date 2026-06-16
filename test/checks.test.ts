import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, makeTempRoot } from "./support";
import { findingIdentifier, missingPublicSpecs } from "../src/specs-check";
import { lintPrBody } from "../src/pr-body-check";

let root: string;

beforeEach(async () => {
  root = await makeTempRoot("symphony-ts-checks");
});

afterEach(async () => {
  await cleanup(root);
});

describe("specs check", () => {
  test("reports missing @spec for public functions", async () => {
    await writeModule("sample.ex", `defmodule Sample do
  def missing(arg), do: arg
end
`);

    const findings = await missingPublicSpecs([root]);
    expect(findings.map(findingIdentifier)).toEqual(["Sample.missing/1"]);
  });

  test("accepts adjacent @spec and allows defp without @spec", async () => {
    await writeModule("sample.ex", `defmodule Sample do
  @spec ok(term()) :: term()
  def ok(arg), do: arg

  def public do
    helper(:ok)
  end

  defp helper(value), do: value
end
`);

    const findings = await missingPublicSpecs([root]);
    expect(findings.map(findingIdentifier)).toEqual(["Sample.public/0"]);
  });

  test("exempts callback implementations marked with @impl and explicit exemptions", async () => {
    await writeModule("worker.ex", `defmodule Worker do
  @behaviour GenServer

  @impl true
  def init(state), do: {:ok, state}
end
`);
    await writeModule("sample.ex", `defmodule Sample do
  def legacy(arg), do: arg
end
`);

    let findings = await missingPublicSpecs([join(root, "worker.ex")]);
    expect(findings).toEqual([]);
    findings = await missingPublicSpecs([root], { exemptions: ["Sample.legacy/1"] });
    expect(findings).toEqual([]);
  });
});

describe("PR body check", () => {
  const template = `#### Context

<!-- Why is this change needed? -->

#### TL;DR

*<!-- A short summary -->*

#### Summary

- <!-- Summary bullet -->

#### Alternatives

- <!-- Alternative bullet -->

#### Test Plan

- [ ] <!-- Test checkbox -->
`;

  const validBody = `#### Context

Context text.

#### TL;DR

Short summary.

#### Summary

- First change.

#### Alternatives

- Alternative considered.

#### Test Plan

- [x] Ran targeted checks.
`;

  test("fails when template has no headings", () => {
    expect(lintPrBody("no headings here", validBody)).toEqual({
      ok: false,
      errors: ["No markdown headings found"],
    });
  });

  test("fails when body still has placeholders, missing headings, or out-of-order headings", () => {
    expect(lintPrBody(template, template).errors).toContain(
      "PR description still contains template placeholder comments (<!-- ... -->).",
    );

    const missingHeading = validBody.replace("#### Alternatives\n\n- Alternative considered.\n\n", "");
    expect(lintPrBody(template, missingHeading).errors).toContain("Missing required heading: #### Alternatives");

    const outOfOrder = `#### TL;DR

Short summary.

#### Context

Context text.

#### Summary

- First change.

#### Alternatives

- Alternative considered.

#### Test Plan

- [x] Ran targeted checks.
`;
    expect(lintPrBody(template, outOfOrder).errors).toContain("Required headings are out of order.");
  });

  test("fails on empty sections and bullet or checkbox expectation mismatches", () => {
    const emptyContext = validBody.replace("Context text.", "");
    expect(lintPrBody(template, emptyContext).errors).toContain("Section cannot be empty: #### Context");

    const invalidBody = `#### Context

Context text.

#### TL;DR

Short summary.

#### Summary

Not a bullet.

#### Alternatives

Also not a bullet.

#### Test Plan

No checkbox.
`;

    const errors = lintPrBody(template, invalidBody).errors;
    expect(errors).toContain("Section must include at least one bullet item: #### Summary");
    expect(errors).toContain("Section must include at least one bullet item: #### Alternatives");
    expect(errors).toContain("Section must include at least one bullet item: #### Test Plan");
    expect(errors).toContain("Section must include at least one checkbox item: #### Test Plan");
  });

  test("passes for valid body", () => {
    expect(lintPrBody(template, validBody)).toEqual({ ok: true, errors: [] });
  });
});

async function writeModule(relPath: string, source: string): Promise<void> {
  const path = join(root, relPath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, source);
}
