/**
 * HTML wireframe renderer. Same output as scripts/preview-pbir.ps1: one to-scale SVG per page with
 * every visual drawn as a labelled box, so a generator can see what it built without opening Power BI.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { NO_QUERY_TYPES, PageSummary, VisualSummary, readReport } from './pbir.js';

interface Family {
  label: string;
  fill: string;
  stroke: string;
  ink: string;
}

const FAMILIES: Record<string, Family> = {
  text: { label: 'Text / decoration', fill: '#F3F2F1', stroke: '#8A8886', ink: '#605E5C' },
  card: { label: 'Card / KPI', fill: '#EAF1FB', stroke: '#2E5EAA', ink: '#1F4380' },
  chart: { label: 'Chart', fill: '#E9F5EE', stroke: '#3C9E64', ink: '#2A6E46' },
  table: { label: 'Table / matrix', fill: '#F1ECF8', stroke: '#7A5EA8', ink: '#563F79' },
  slicer: { label: 'Slicer / filter', fill: '#FDF3E3', stroke: '#C2851E', ink: '#8A5E14' },
  other: { label: 'Other', fill: '#F5F5F5', stroke: '#A19F9D', ink: '#605E5C' },
};

const FAMILY_OF: Record<string, keyof typeof FAMILIES> = {};
for (const t of ['textbox', 'image', 'shape', 'basicShape', 'actionButton', 'blank']) FAMILY_OF[t] = 'text';
for (const t of ['cardVisual', 'card', 'multiRowCard', 'kpi', 'gauge']) FAMILY_OF[t] = 'card';
for (const t of [
  'barChart', 'columnChart', 'clusteredBarChart', 'clusteredColumnChart', 'stackedBarChart',
  'stackedColumnChart', 'lineChart', 'areaChart', 'stackedAreaChart', 'lineStackedColumnComboChart',
  'lineClusteredColumnComboChart', 'pieChart', 'donutChart', 'treemap', 'funnel', 'waterfallChart',
  'scatterChart', 'ribbonChart', 'map', 'filledMap', 'shapeMap',
]) FAMILY_OF[t] = 'chart';
for (const t of ['tableEx', 'pivotTable', 'matrix']) FAMILY_OF[t] = 'table';
for (const t of ['slicer', 'advancedSlicerVisual']) FAMILY_OF[t] = 'slicer';

const RED = '#A4262C';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(text: string, maxChars: number): string {
  if (maxChars < 4) return '';
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + '…';
}

function issuesFor(visual: VisualSummary, page: PageSummary, all: VisualSummary[]): string[] {
  const issues: string[] = [];
  const p = visual.position;

  if (p.width <= 0 || p.height <= 0) issues.push('zero or negative size');
  if (p.x + p.width > page.width + 0.5 || p.y + p.height > page.height + 0.5 || p.x < -0.5 || p.y < -0.5) {
    issues.push('extends past the canvas');
  }
  if (Object.keys(visual.bindings).length === 0 && !NO_QUERY_TYPES.has(visual.visualType)) {
    issues.push('no field bindings - renders empty');
  }
  for (const other of all) {
    if (other === visual) continue;
    const o = other.position;
    const ox = Math.min(p.x + p.width, o.x + o.width) - Math.max(p.x, o.x);
    const oy = Math.min(p.y + p.height, o.y + o.height) - Math.max(p.y, o.y);
    if (ox > 1 && oy > 1) issues.push(`overlaps '${other.folder}'`);
  }
  return issues;
}

export interface PreviewResult {
  html: string;
  pages: number;
  visuals: number;
  issues: number;
}

export async function renderPreview(reportPath: string, pageFilter?: string): Promise<PreviewResult> {
  const report = await readReport(reportPath);
  const pages = pageFilter
    ? report.pages.filter((p) => p.folder === pageFilter || p.displayName === pageFilter)
    : report.pages;

  if (pages.length === 0) throw new Error(pageFilter ? `No page matched '${pageFilter}'.` : 'Report has no pages.');

  const label = path.basename(reportPath);
  let totalVisuals = 0;
  let totalIssues = 0;
  const sections: string[] = [];

  for (const page of pages) {
    const svg: string[] = [];
    const issueList: string[] = [];

    svg.push(
      `<svg viewBox="0 0 ${page.width} ${page.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Wireframe of page ${esc(page.displayName)}">`,
    );
    svg.push(`<rect x="0" y="0" width="${page.width}" height="${page.height}" fill="#FFFFFF" stroke="#D2D0CE" stroke-width="1"/>`);

    for (const v of page.visuals) {
      totalVisuals++;
      const p = v.position;
      if (p.width <= 0 || p.height <= 0) continue;

      const issues = [...new Set(issuesFor(v, page, page.visuals))];
      totalIssues += issues.length;
      for (const issue of issues) {
        issueList.push(`<li><code>${esc(v.folder)}</code> (${esc(v.visualType)}) &mdash; ${esc(issue)}</li>`);
      }

      const fam = FAMILIES[FAMILY_OF[v.visualType] ?? 'other'];
      const broken = issues.length > 0;
      const stroke = broken ? RED : fam.stroke;
      const dash = broken ? ' stroke-dasharray="6 3"' : '';

      svg.push(
        `<rect x="${r(p.x)}" y="${r(p.y)}" width="${r(p.width)}" height="${r(p.height)}" rx="6" fill="${fam.fill}" stroke="${stroke}" stroke-width="1.5"${dash}/>`,
      );

      // Priority decides what survives in a short box: the folder name and any issue always win,
      // then the payload, and the visual type is dropped first - the folder name usually implies it.
      const lines: { text: string; weight: string; size: number; color: string; prio: number }[] = [
        { text: v.folder, weight: '600', size: 12, color: fam.ink, prio: 1 },
        { text: v.visualType, weight: '400', size: 10.5, color: '#605E5C', prio: 4 },
      ];
      if (v.text) lines.push({ text: `"${v.text}"`, weight: '400', size: 10.5, color: '#252423', prio: 3 });
      for (const [role, fields] of Object.entries(v.bindings)) {
        lines.push({
          text: `${role}: ${fields.map((f) => `${f.table}[${f.field}]`).join(', ')}`,
          weight: '400',
          size: 10.5,
          color: '#252423',
          prio: 3,
        });
      }
      if (broken) lines.push({ text: issues.join('; '), weight: '600', size: 10.5, color: RED, prio: 2 });

      const showBadge = p.height >= 40 && p.width >= 130;
      const reserved = showBadge ? 16 : 4;
      const lineHeight = 14;
      const maxLines = Math.max(1, Math.floor((p.height - 12 - reserved) / lineHeight));
      const charBudget = Math.floor((p.width - 16) / 5.6);

      const visible = lines
        .map((line, index) => ({ ...line, index }))
        .sort((a, b) => a.prio - b.prio || a.index - b.index)
        .slice(0, maxLines)
        .sort((a, b) => a.index - b.index);

      visible.forEach((line, i) => {
        const text = truncate(line.text, charBudget);
        if (!text.trim()) return;
        svg.push(
          `<text x="${r(p.x + 8)}" y="${r(p.y + 18 + i * lineHeight)}" font-family="Segoe UI, system-ui, sans-serif" font-size="${line.size}" font-weight="${line.weight}" fill="${line.color}">${esc(text)}</text>`,
        );
      });

      if (showBadge) {
        svg.push(
          `<text x="${r(p.x + p.width - 8)}" y="${r(p.y + p.height - 8)}" text-anchor="end" font-family="Consolas, monospace" font-size="9.5" fill="#A19F9D">${Math.round(p.x)},${Math.round(p.y)} &#183; ${Math.round(p.width)}&#215;${Math.round(p.height)}</text>`,
        );
      }
    }

    svg.push('</svg>');

    const indexNote = page.indexed ? '' : ' &middot; <strong>not listed in pages.json</strong>';
    sections.push(
      [
        '<section>',
        `<h2>${esc(page.displayName)}</h2>`,
        `<div class="pagemeta">folder <code>${esc(page.folder)}</code> &middot; ${page.width}&times;${page.height} &middot; ${page.visuals.length} visual(s)${indexNote}</div>`,
        '<div class="canvas">',
        svg.join('\n'),
        '</div>',
        issueList.length > 0 ? `<ul class="issues">${issueList.join('')}</ul>` : '',
        '</section>',
      ].join('\n'),
    );
  }

  const badge =
    totalIssues === 0
      ? '<span class="pill ok">no issues</span>'
      : `<span class="pill bad">${totalIssues} issue${totalIssues === 1 ? '' : 's'}</span>`;

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(label)} - layout preview</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body><div class="wrap">',
    '<header>',
    `<h1>${esc(label)}</h1>`,
    `<div class="sub">${pages.length} page(s) &middot; ${totalVisuals} visual(s) &middot; generated ${timestamp()}${badge}</div>`,
    '</header>',
    sections.join('\n'),
    '<div class="legend">',
    Object.values(FAMILIES)
      .map((f) => `<span><i class="swatch" style="background:${f.fill};border-color:${f.stroke}"></i>${f.label}</span>`)
      .join(''),
    `<span><i class="swatch" style="background:#fff;border-color:${RED};border-style:dashed"></i>Has an issue</span>`,
    '</div>',
    '<footer>Wireframe only - box positions are exact, but this is not a render of the actual visuals. Open the .pbip in Power BI Desktop to see real output.</footer>',
    '</div></body></html>',
    '',
  ].join('\n');

  return { html, pages: pages.length, visuals: totalVisuals, issues: totalIssues };
}

export async function writePreview(
  reportPath: string,
  outputPath?: string,
  pageFilter?: string,
): Promise<PreviewResult & { outputPath: string }> {
  const result = await renderPreview(reportPath, pageFilter);
  const target =
    outputPath ??
    path.join(path.dirname(reportPath), `${path.basename(reportPath).replace(/\.Report$/, '')}-preview.html`);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, result.html, { encoding: 'utf8' });
  return { ...result, outputPath: target };
}

function r(n: number): number {
  return Math.round(n * 10) / 10;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #FAF9F8; color: #252423;
       font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
.wrap { max-width: 1360px; margin: 0 auto; padding: 32px 24px 64px; }
header { border-bottom: 1px solid #E1DFDD; padding-bottom: 20px; margin-bottom: 32px; }
h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
.sub { color: #605E5C; font-size: 13px; }
.pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px;
        font-weight: 600; margin-left: 8px; }
.pill.ok { background: #E9F5EE; color: #2A6E46; }
.pill.bad { background: #FDECEA; color: #A4262C; }
section { margin-bottom: 44px; }
h2 { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
.pagemeta { color: #605E5C; font-size: 12px; margin-bottom: 14px; }
.canvas { background: #fff; border: 1px solid #E1DFDD; border-radius: 10px; padding: 12px;
          box-shadow: 0 1px 3px rgba(0,0,0,.04); overflow-x: auto; }
svg { display: block; width: 100%; height: auto; min-width: 640px; }
ul.issues { list-style: none; padding: 0; margin: 14px 0 0; }
ul.issues li { background: #FDECEA; border-left: 3px solid #A4262C; padding: 7px 12px;
               margin-bottom: 6px; border-radius: 0 4px 4px 0; font-size: 13px; }
ul.issues code { background: rgba(0,0,0,.05); padding: 1px 5px; border-radius: 3px;
                 font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 40px; padding-top: 20px;
          border-top: 1px solid #E1DFDD; font-size: 12px; color: #605E5C; }
.legend span { display: flex; align-items: center; gap: 7px; }
.swatch { width: 14px; height: 14px; border-radius: 3px; border: 1.5px solid; }
footer { margin-top: 32px; color: #8A8886; font-size: 12px; }
`;
