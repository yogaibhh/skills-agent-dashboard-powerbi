/**
 * Validation. Errors mean the report is broken; warnings mean it opens but probably reads badly.
 *
 * Mirrors the rule set in scripts/validate-pbir.ps1 so the two agree on what "valid" means.
 */

import * as path from 'node:path';
import { NO_QUERY_TYPES, exists, readJson, readReport } from './pbir.js';
import { readSemanticModel, resolveField } from './tmdl.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  rule: string;
  where: string;
  message: string;
}

export interface ValidationResult {
  reportPath: string;
  findings: Finding[];
  errors: number;
  warnings: number;
  pages: number;
  visuals: number;
  fieldRefs: number;
}

export async function validateReport(reportPath: string, modelPath?: string): Promise<ValidationResult> {
  const findings: Finding[] = [];
  const add = (severity: Severity, rule: string, where: string, message: string) =>
    findings.push({ severity, rule, where, message });

  for (const rel of ['definition.pbir', 'definition/report.json', 'definition/version.json', 'definition/pages/pages.json']) {
    if (!(await exists(path.join(reportPath, ...rel.split('/'))))) {
      add('error', 'missing-file', rel, 'Required file is missing.');
    }
  }

  const report = await readReport(reportPath);

  // --- model binding ---
  if (report.binding.kind === 'none') {
    add('error', 'binding-missing', 'definition.pbir', 'No usable datasetReference - the report is not bound to a model.');
  } else if (report.binding.kind === 'byPath') {
    const resolved = path.resolve(reportPath, report.binding.value);
    if (!(await exists(resolved))) {
      add('error', 'binding-broken', 'definition.pbir', `byPath target does not exist: ${report.binding.value}`);
    }
  }

  // --- pages ---
  if (report.pages.length === 0) add('error', 'pages-empty', 'pages.json', 'The report has no pages.');
  if (!report.activePageName) {
    add('warning', 'active-page-missing', 'pages.json', 'activePageName is not set.');
  } else if (!report.pageOrder.includes(report.activePageName)) {
    add('error', 'active-page-orphan', 'pages.json', `activePageName '${report.activePageName}' is not in pageOrder.`);
  }

  const onDisk = new Set(report.pages.map((p) => p.name));
  for (const declared of report.pageOrder) {
    if (!onDisk.has(declared)) {
      add('error', 'page-orphan-index', 'pages.json', `pageOrder lists '${declared}' but no page.json carries that name.`);
    }
  }

  // --- visuals ---
  const seenNames = new Map<string, string>();
  let visualCount = 0;
  const refs: { where: string; table: string; field: string; kind: 'Measure' | 'Column' }[] = [];

  for (const page of report.pages) {
    const pageLabel = `pages/${page.folder}`;

    if (!page.name) {
      add('error', 'page-no-name', pageLabel, 'page.json has no name property.');
      continue;
    }
    if (!page.indexed) {
      add('error', 'page-not-indexed', pageLabel, `Page name '${page.name}' is not in pages.json -> pageOrder. It will not render.`);
    }
    if (page.visuals.length === 0) {
      add('warning', 'page-empty', pageLabel, 'Page has no visuals - it will render blank.');
      continue;
    }

    for (const v of page.visuals) {
      visualCount++;
      const label = `${pageLabel}/visuals/${v.folder}`;

      if (!v.name) add('error', 'visual-no-name', label, 'visual.json has no name property.');
      else if (seenNames.has(v.name)) {
        add('error', 'visual-duplicate-name', label, `Duplicate name '${v.name}' - also used by ${seenNames.get(v.name)}.`);
      } else seenNames.set(v.name, label);

      if (!v.visualType || v.visualType === 'unknown') {
        add('error', 'visual-no-type', label, 'visual.visualType is missing.');
      }

      const { x, y, width, height } = v.position;
      if (width <= 0 || height <= 0) {
        add('error', 'visual-zero-size', label, `width/height must be positive (got ${width} x ${height}).`);
      }
      if (x < -0.5 || y < -0.5) {
        add('warning', 'visual-negative-origin', label, `Visual starts off-canvas at (${x}, ${y}).`);
      }
      if (x + width > page.width + 0.5 || y + height > page.height + 0.5) {
        add(
          'warning',
          'visual-out-of-bounds',
          label,
          `Extends past the ${page.width}x${page.height} canvas (ends at ${round(x + width)}, ${round(y + height)}).`,
        );
      }

      const roles = Object.keys(v.bindings);
      if (roles.length === 0 && v.visualType && !NO_QUERY_TYPES.has(v.visualType)) {
        add('error', 'visual-unbound', label, `'${v.visualType}' has no field bindings - it will render as an empty placeholder.`);
      }

      for (const fields of Object.values(v.bindings)) {
        for (const f of fields) refs.push({ where: label, table: f.table, field: f.field, kind: f.kind });
      }
    }

    // --- overlaps, 1px tolerance so adjacent visuals do not trip it ---
    for (let i = 0; i < page.visuals.length; i++) {
      for (let j = i + 1; j < page.visuals.length; j++) {
        const a = page.visuals[i].position;
        const b = page.visuals[j].position;
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        if (ox > 1 && oy > 1) {
          add(
            'warning',
            'visual-overlap',
            `${pageLabel}/visuals/${page.visuals[i].folder}`,
            `Overlaps '${page.visuals[j].folder}' by ${round(ox)}x${round(oy)} px.`,
          );
        }
      }
    }
  }

  // --- field references against the model ---
  if (modelPath) {
    try {
      const model = await readSemanticModel(modelPath);
      add('info', 'model-loaded', 'modelPath', `Loaded ${model.tables.length} table(s) from TMDL.`);

      const reported = new Set<string>();
      for (const ref of refs) {
        const key = `${ref.where}|${ref.table}|${ref.field}|${ref.kind}`;
        if (reported.has(key)) continue;
        reported.add(key);

        const result = resolveField(model, ref.table, ref.field, ref.kind);
        if (result.ok) continue;

        // A case difference still resolves at runtime; a missing object does not.
        const isCase = result.message.includes('differs in case');
        add(isCase ? 'warning' : 'error', isCase ? 'ref-case' : 'ref-missing', ref.where, result.message);
      }
    } catch (err: any) {
      add('warning', 'model-unreadable', 'modelPath', `${err.message} Field references were not checked.`);
    }
  }

  // --- JSON validity of every visual, caught while reading ---
  for (const page of report.pages) {
    const visualsDir = path.join(reportPath, 'definition', 'pages', page.folder, 'visuals');
    if (!(await exists(visualsDir))) continue;
    for (const v of page.visuals) {
      const file = path.join(visualsDir, v.folder, 'visual.json');
      try {
        await readJson(file);
      } catch (err: any) {
        add('error', 'json-invalid', `pages/${page.folder}/visuals/${v.folder}`, `Not valid JSON: ${err.message}`);
      }
    }
  }

  return {
    reportPath,
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    pages: report.pages.length,
    visuals: visualCount,
    fieldRefs: refs.length,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function formatFindings(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push(
    `${result.pages} page(s), ${result.visuals} visual(s), ${result.fieldRefs} field reference(s)`,
  );
  lines.push('');

  for (const severity of ['error', 'warning', 'info'] as Severity[]) {
    for (const f of result.findings.filter((x) => x.severity === severity)) {
      lines.push(`[${severity.toUpperCase()}] ${f.rule} — ${f.where}`);
      lines.push(`    ${f.message}`);
    }
  }

  lines.push('');
  // Info findings are commentary, not problems, so a report carrying only those is still clean.
  lines.push(
    result.errors === 0 && result.warnings === 0
      ? 'No issues found.'
      : `${result.errors} error(s), ${result.warnings} warning(s).`,
  );
  return lines.join('\n');
}
