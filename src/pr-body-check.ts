import { err, ok, type Result } from "./result";

export type PrBodyLintResult = { ok: boolean; errors: string[] };

export function lintPrBody(template: string, body: string): PrBodyLintResult {
  const headings = extractTemplateHeadings(template);
  if (headings.length === 0) return { ok: false, errors: ["No markdown headings found"] };

  const errors: string[] = [];
  checkRequiredHeadings(errors, body, headings);
  checkOrder(errors, body, headings);
  checkNoPlaceholders(errors, body);
  checkSectionsFromTemplate(errors, template, body, headings);
  return { ok: errors.length === 0, errors };
}

function extractTemplateHeadings(template: string): string[] {
  return template.match(/^#{4,6}\s+.+$/gm) ?? [];
}

function checkRequiredHeadings(errors: string[], body: string, headings: string[]): void {
  for (const heading of headings) {
    if (!body.includes(heading)) errors.push(`Missing required heading: ${heading}`);
  }
}

function checkOrder(errors: string[], body: string, headings: string[]): void {
  const positions = headings.map((heading) => body.indexOf(heading)).filter((position) => position >= 0);
  const sorted = [...positions].sort((left, right) => left - right);
  if (positions.some((position, index) => position !== sorted[index])) errors.push("Required headings are out of order.");
}

function checkNoPlaceholders(errors: string[], body: string): void {
  if (body.includes("<!--")) errors.push("PR description still contains template placeholder comments (<!-- ... -->).");
}

function checkSectionsFromTemplate(errors: string[], template: string, body: string, headings: string[]): void {
  for (const heading of headings) {
    const templateSection = captureHeadingSection(template, heading, headings);
    const bodySection = captureHeadingSection(body, heading, headings);
    if (bodySection === null) continue;
    if (bodySection.trim() === "") {
      errors.push(`Section cannot be empty: ${heading}`);
      continue;
    }
    if (/^- /m.test(templateSection ?? "") && !/^- /m.test(bodySection)) {
      errors.push(`Section must include at least one bullet item: ${heading}`);
    }
    if (/^- \[ \] /m.test(templateSection ?? "") && !/^- \[[ xX]\] /m.test(bodySection)) {
      errors.push(`Section must include at least one checkbox item: ${heading}`);
    }
  }
}

function captureHeadingSection(doc: string, heading: string, headings: string[]): string | null {
  const headingIndex = doc.indexOf(heading);
  if (headingIndex < 0) return null;
  const sectionStart = headingIndex + heading.length;
  if (sectionStart + 2 > doc.length) return "";
  if (doc.slice(sectionStart, sectionStart + 2) !== "\n\n") return null;
  const contentStart = sectionStart + 2;
  const content = doc.slice(contentStart);
  const nextOffsets = headings
    .filter((nextHeading) => nextHeading !== heading)
    .map((nextHeading) => content.indexOf(`\n${nextHeading}`))
    .filter((offset) => offset >= 0);
  const nextOffset = nextOffsets.length === 0 ? undefined : Math.min(...nextOffsets);
  return nextOffset === undefined ? content : content.slice(0, nextOffset);
}
