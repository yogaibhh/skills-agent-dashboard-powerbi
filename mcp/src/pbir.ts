/**
 * PBIR primitives: types, file IO, and the report scaffold.
 *
 * Everything written here is byte-compatible with what Power BI Desktop writes, which notably means
 * UTF-8 with no BOM and LF-free JSON produced by JSON.stringify with two-space indentation.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const SCHEMA = {
  visual: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.1.0/schema.json',
  page: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/1.4.0/schema.json',
  pages: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json',
  report: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.0.0/schema.json',
  version: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json',
  pbir: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
  pbip: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
  platform: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
} as const;

export interface Position {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  tabOrder: number;
}

export type FieldKind = 'Measure' | 'Column';

export interface FieldRef {
  table: string;
  field: string;
  kind: FieldKind;
}

/** role name (Category, Y, Values, Data, Rows, ...) -> the fields bound to it, in order */
export type Bindings = Record<string, FieldRef[]>;

export interface VisualSummary {
  folder: string;
  name: string;
  visualType: string;
  position: Position;
  bindings: Bindings;
  text?: string;
}

export interface PageSummary {
  folder: string;
  name: string;
  displayName: string;
  width: number;
  height: number;
  indexed: boolean;
  visuals: VisualSummary[];
}

export interface ReportSummary {
  reportPath: string;
  binding: { kind: 'byPath' | 'byConnection' | 'none'; value: string };
  pageOrder: string[];
  activePageName: string;
  pages: PageSummary[];
}

/** Visual types that legitimately carry no field bindings. */
export const NO_QUERY_TYPES = new Set([
  'textbox',
  'image',
  'shape',
  'basicShape',
  'actionButton',
  'blank',
]);

// ---------------------------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------------------------

/** 20 lowercase hex characters, the token format PBIR uses for internal object names. */
export function newPbirName(): string {
  let out = '';
  for (let i = 0; i < 20; i++) out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return out;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // No BOM: Power BI's own PBIR files have none, and some tooling downstream chokes on it.
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
}

export async function readJson<T = any>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw.replace(/^﻿/, '')) as T;
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------------------------

/** Turns a field reference into the projection shape PBIR expects. */
export function projection(ref: FieldRef, active: boolean): Record<string, unknown> {
  const node: Record<string, unknown> = {
    field: {
      [ref.kind]: {
        Expression: { SourceRef: { Entity: ref.table } },
        Property: ref.field,
      },
    },
    queryRef: `${ref.table}.${ref.field}`,
    nativeQueryRef: ref.field,
  };
  // active marks the first projection of a role; setting it on the others is wrong.
  if (active) node.active = true;
  return node;
}

export function queryState(bindings: Bindings): Record<string, unknown> | undefined {
  const roles = Object.entries(bindings).filter(([, fields]) => fields && fields.length > 0);
  if (roles.length === 0) return undefined;

  const state: Record<string, unknown> = {};
  for (const [role, fields] of roles) {
    state[role] = { projections: fields.map((f, i) => projection(f, i === 0)) };
  }
  return state;
}

/** Reads bindings back out of a parsed visual.json. */
export function readBindings(visual: any): Bindings {
  const out: Bindings = {};
  const state = visual?.visual?.query?.queryState;
  if (!state || typeof state !== 'object') return out;

  for (const [role, body] of Object.entries<any>(state)) {
    const fields: FieldRef[] = [];
    for (const proj of body?.projections ?? []) {
      for (const kind of ['Measure', 'Column'] as FieldKind[]) {
        const node = proj?.field?.[kind];
        const table = node?.Expression?.SourceRef?.Entity;
        if (node && table && node.Property) {
          fields.push({ table, field: node.Property, kind });
        }
      }
    }
    if (fields.length > 0) out[role] = fields;
  }
  return out;
}

/** Pulls the visible text out of a textbox visual, for previews and summaries. */
export function readTextContent(visual: any): string | undefined {
  if (visual?.visual?.visualType !== 'textbox') return undefined;
  const runs: string[] = [];
  for (const group of visual.visual.objects?.general ?? []) {
    for (const para of group?.properties?.paragraphs ?? []) {
      for (const run of para?.textRuns ?? []) {
        if (typeof run?.value === 'string') runs.push(run.value);
      }
    }
  }
  return runs.length > 0 ? runs.join(' ') : undefined;
}

// ---------------------------------------------------------------------------------------------
// Report scaffold
// ---------------------------------------------------------------------------------------------

export interface CreateReportOptions {
  name: string;
  outputPath: string;
  modelPath?: string;
  semanticModelId?: string;
  pageName?: string;
  force?: boolean;
}

export interface CreateReportResult {
  reportPath: string;
  pbipPath: string;
  pageFolder: string;
  pageName: string;
  logicalId: string;
  binding: string;
}

const THEME = {
  name: 'DashboardBuilderTheme',
  dataColors: ['#2E5EAA', '#E8833A', '#3C9E64', '#B5495B', '#7A5EA8', '#0E7C86', '#C2A83E', '#6E7B8B'],
  background: '#FFFFFF',
  foreground: '#252423',
  tableAccent: '#2E5EAA',
  good: '#3C9E64',
  neutral: '#C2A83E',
  bad: '#B5495B',
  maximum: '#2E5EAA',
  center: '#E8E8E8',
  minimum: '#B5495B',
  textClasses: {
    title: { fontFace: 'Segoe UI Semibold', fontSize: 14, color: '#252423' },
    label: { fontFace: 'Segoe UI', fontSize: 10, color: '#605E5C' },
    callout: { fontFace: 'Segoe UI Semibold', fontSize: 28, color: '#252423' },
  },
  visualStyles: {
    '*': {
      '*': {
        background: [{ show: true, transparency: 0 }],
        border: [{ show: true, radius: 8, color: { solid: { color: '#E1DFDD' } } }],
        dropShadow: [{ show: false }],
      },
    },
  },
};

export async function createReport(options: CreateReportOptions): Promise<CreateReportResult> {
  const { name, outputPath } = options;

  if (/[<>:"/\\|?*]/.test(name)) {
    throw new Error(`Report name '${name}' contains characters that are not valid in a file name.`);
  }
  if (!options.modelPath && !options.semanticModelId) {
    throw new Error('Provide either modelPath (local development) or semanticModelId (workspace deployment).');
  }
  if (options.modelPath && options.semanticModelId) {
    throw new Error('modelPath and semanticModelId are mutually exclusive.');
  }

  const reportPath = path.join(outputPath, `${name}.Report`);
  const pbipPath = path.join(outputPath, `${name}.pbip`);

  if (await exists(reportPath)) {
    if (!options.force) throw new Error(`'${reportPath}' already exists. Pass force: true to overwrite it.`);
    await fs.rm(reportPath, { recursive: true, force: true });
  }

  const logicalId = crypto.randomUUID();
  const pageName = newPbirName();
  const pageFolder = 'overview';
  const pageDisplayName = options.pageName ?? 'Overview';

  await writeJson(path.join(reportPath, '.platform'), {
    $schema: SCHEMA.platform,
    metadata: { type: 'Report', displayName: name },
    config: { version: '2.0', logicalId },
  });

  const datasetReference = options.semanticModelId
    ? { byConnection: { connectionString: `semanticmodelid=${options.semanticModelId}` } }
    : { byPath: { path: options.modelPath } };

  await writeJson(path.join(reportPath, 'definition.pbir'), {
    $schema: SCHEMA.pbir,
    version: '4.0',
    datasetReference,
  });

  await writeJson(path.join(reportPath, 'definition', 'version.json'), {
    $schema: SCHEMA.version,
    version: '2.0.0',
  });

  await writeJson(path.join(reportPath, 'definition', 'report.json'), {
    $schema: SCHEMA.report,
    themeCollection: {
      baseTheme: { name: 'CY24SU10', type: 'SharedResources' },
      customTheme: { name: 'theme.json', type: 'RegisteredResources' },
    },
    resourcePackages: [
      {
        name: 'SharedResources',
        type: 'SharedResources',
        items: [{ name: 'CY24SU10', path: 'BaseThemes/CY24SU10.json', type: 'BaseTheme' }],
      },
      {
        name: 'RegisteredResources',
        type: 'RegisteredResources',
        items: [{ name: 'theme.json', path: 'theme.json', type: 'CustomTheme' }],
      },
    ],
    settings: {
      useStylableVisualContainerHeader: true,
      defaultFilterActionIsDataFilter: true,
      defaultDrillFilterOtherVisuals: true,
      allowChangeFilterTypes: true,
      allowInlineExploration: true,
      useEnhancedTooltips: true,
    },
  });

  await writeJson(path.join(reportPath, 'StaticResources', 'RegisteredResources', 'theme.json'), THEME);

  await writeJson(path.join(reportPath, 'definition', 'pages', 'pages.json'), {
    $schema: SCHEMA.pages,
    pageOrder: [pageName],
    activePageName: pageName,
  });

  await writeJson(path.join(reportPath, 'definition', 'pages', pageFolder, 'page.json'), {
    $schema: SCHEMA.page,
    name: pageName,
    displayName: pageDisplayName,
    displayOption: 'FitToPage',
    height: 720,
    width: 1280,
  });

  await fs.mkdir(path.join(reportPath, 'definition', 'pages', pageFolder, 'visuals'), { recursive: true });

  await writeJson(pbipPath, {
    $schema: SCHEMA.pbip,
    version: '1.0',
    artifacts: [{ report: { path: `${name}.Report` } }],
    settings: { enableAutoRecovery: true },
  });

  return {
    reportPath,
    pbipPath,
    pageFolder,
    pageName,
    logicalId,
    binding: options.semanticModelId ? `byConnection -> ${options.semanticModelId}` : `byPath -> ${options.modelPath}`,
  };
}

export async function addPage(
  reportPath: string,
  pageFolder: string,
  displayName: string,
  makeActive = false,
): Promise<{ pageFolder: string; pageName: string }> {
  const pagesDir = path.join(reportPath, 'definition', 'pages');
  const pagesFile = path.join(pagesDir, 'pages.json');

  if (!(await exists(pagesFile))) throw new Error(`Not a PBIR report: ${pagesFile} is missing.`);
  if (await exists(path.join(pagesDir, pageFolder))) {
    throw new Error(`Page folder '${pageFolder}' already exists.`);
  }

  const meta = await readJson<any>(pagesFile);
  const pageName = newPbirName();

  await writeJson(path.join(pagesDir, pageFolder, 'page.json'), {
    $schema: SCHEMA.page,
    name: pageName,
    displayName,
    displayOption: 'FitToPage',
    height: 720,
    width: 1280,
  });
  await fs.mkdir(path.join(pagesDir, pageFolder, 'visuals'), { recursive: true });

  meta.pageOrder = [...(meta.pageOrder ?? []), pageName];
  if (makeActive || !meta.activePageName) meta.activePageName = pageName;
  await writeJson(pagesFile, meta);

  return { pageFolder, pageName };
}

// ---------------------------------------------------------------------------------------------
// Reading an existing report
// ---------------------------------------------------------------------------------------------

export async function readReport(reportPath: string): Promise<ReportSummary> {
  const pagesDir = path.join(reportPath, 'definition', 'pages');
  if (!(await exists(pagesDir))) {
    throw new Error(`Not a PBIR report folder (no definition/pages): ${reportPath}`);
  }

  let binding: ReportSummary['binding'] = { kind: 'none', value: '' };
  const pbirPath = path.join(reportPath, 'definition.pbir');
  if (await exists(pbirPath)) {
    const pbir = await readJson<any>(pbirPath);
    if (pbir?.datasetReference?.byPath?.path) {
      binding = { kind: 'byPath', value: pbir.datasetReference.byPath.path };
    } else if (pbir?.datasetReference?.byConnection?.connectionString) {
      binding = { kind: 'byConnection', value: pbir.datasetReference.byConnection.connectionString };
    }
  }

  let pageOrder: string[] = [];
  let activePageName = '';
  const pagesFile = path.join(pagesDir, 'pages.json');
  if (await exists(pagesFile)) {
    const meta = await readJson<any>(pagesFile);
    pageOrder = meta?.pageOrder ?? [];
    activePageName = meta?.activePageName ?? '';
  }

  const pages: PageSummary[] = [];
  for (const entry of await fs.readdir(pagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pageFile = path.join(pagesDir, entry.name, 'page.json');
    if (!(await exists(pageFile))) continue;

    const page = await readJson<any>(pageFile);
    const visualsDir = path.join(pagesDir, entry.name, 'visuals');
    const visuals: VisualSummary[] = [];

    if (await exists(visualsDir)) {
      for (const v of await fs.readdir(visualsDir, { withFileTypes: true })) {
        if (!v.isDirectory()) continue;
        const visualFile = path.join(visualsDir, v.name, 'visual.json');
        if (!(await exists(visualFile))) continue;

        const visual = await readJson<any>(visualFile);
        visuals.push({
          folder: v.name,
          name: visual?.name ?? '',
          visualType: visual?.visual?.visualType ?? 'unknown',
          position: {
            x: visual?.position?.x ?? 0,
            y: visual?.position?.y ?? 0,
            z: visual?.position?.z ?? 0,
            width: visual?.position?.width ?? 0,
            height: visual?.position?.height ?? 0,
            tabOrder: visual?.position?.tabOrder ?? 0,
          },
          bindings: readBindings(visual),
          text: readTextContent(visual),
        });
      }
    }

    visuals.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

    pages.push({
      folder: entry.name,
      name: page?.name ?? '',
      displayName: page?.displayName ?? entry.name,
      width: page?.width ?? 1280,
      height: page?.height ?? 720,
      indexed: pageOrder.includes(page?.name),
      visuals,
    });
  }

  pages.sort((a, b) => {
    const ai = pageOrder.indexOf(a.name);
    const bi = pageOrder.indexOf(b.name);
    return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi);
  });

  return { reportPath, binding, pageOrder, activePageName, pages };
}

/** Resolves a page folder name, or the report's only page when the caller did not name one. */
export async function resolvePageFolder(reportPath: string, pageFolder?: string): Promise<string> {
  const report = await readReport(reportPath);
  if (pageFolder) {
    const found = report.pages.find((p) => p.folder === pageFolder || p.displayName === pageFolder);
    if (!found) {
      throw new Error(
        `Page '${pageFolder}' not found. Available: ${report.pages.map((p) => p.folder).join(', ') || '(none)'}`,
      );
    }
    return found.folder;
  }
  if (report.pages.length === 0) throw new Error('Report has no pages.');
  if (report.pages.length > 1) {
    throw new Error(
      `Report has ${report.pages.length} pages; name one explicitly: ${report.pages.map((p) => p.folder).join(', ')}`,
    );
  }
  return report.pages[0].folder;
}
