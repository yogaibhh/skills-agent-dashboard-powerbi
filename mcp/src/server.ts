/**
 * Tool surface.
 *
 * The design rule: a caller says what it wants on the page, never how the JSON is shaped. Every
 * queryState, literal encoding and projection is built here, because those are exactly the parts an
 * LLM gets subtly wrong and Power BI accepts without complaint.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'node:path';

import { BLUEPRINTS, getBlueprint, getSlot, gridWidth, gridX, CANVAS, BANDS } from './blueprints.js';
import { FieldRef, addPage, createReport, readReport, resolvePageFolder, writeTheme } from './pbir.js';
import { THEME_PRESETS, ThemePreset } from './theme.js';
import { applyBlueprint } from './generate.js';
import { classify, readSemanticModel } from './tmdl.js';
import { formatFindings, validateReport } from './validate.js';
import { writePreview } from './preview.js';
import { ROLES, UNVERIFIED_TYPES, removeVisual, writeVisual } from './visuals.js';

export const VERSION = '0.1.0';

const fieldRef = z.object({
  table: z.string().describe('Table name, exactly as it appears in the semantic model (case-sensitive).'),
  field: z.string().describe('Measure or column name, exactly as it appears in the model (case-sensitive).'),
  kind: z.enum(['Measure', 'Column']),
});

const themeOptions = {
  preset: z
    .enum(['light', 'dark', 'minimal'])
    .optional()
    .describe(
      'light: white cards on a soft grey canvas (default, and what most dashboards want). ' +
      'dark: light text on near-black. minimal: no fills or shadows, separation by whitespace only.',
    ),
  accent: z.string().optional().describe('Primary colour as 6-digit hex, e.g. "#2C5F9E". Leads the palette and becomes the table accent.'),
  dataColors: z.array(z.string()).optional().describe('Full categorical palette as hex strings, in series order. Overrides the preset.'),
  pageBackground: z.string().optional().describe('Canvas colour behind the visuals. Keep it distinct from the card colour or the visuals lose their edges.'),
  visualBackground: z.string().optional().describe('Card colour.'),
  cornerRadius: z.number().optional().describe('Corner radius on every visual, 0 to 40. 0 for square corners.'),
  shadow: z.boolean().optional().describe('Soft shadow under each visual.'),
  fontFamily: z.string().optional().describe('Base font, e.g. "Segoe UI".'),
  name: z.string().optional().describe('Theme name shown in Power BI.'),
};

const position = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  z: z.number().optional(),
  tabOrder: z.number().optional(),
});

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

function describeFields(fields: FieldRef[]): string {
  return fields.map((f) => `${f.table}[${f.field}]`).join(', ');
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'powerbi-dashboard', version: VERSION });

  // -------------------------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    'inspect_semantic_model',
    {
      title: 'Inspect semantic model',
      description:
        'Read a *.SemanticModel folder (TMDL) and return its tables, columns and measures, plus ranked ' +
        'candidates for KPI measures, the date table and category columns. Call this before generating ' +
        'anything - every field you bind must come from here. Cardinality is not checked, so verify a ' +
        'category has roughly 3-30 distinct values before charting it.',
      inputSchema: {
        modelPath: z.string().describe('Path to the *.SemanticModel folder, or any folder containing .tmdl files.'),
        full: z.boolean().optional().describe('Include every column of every table. Off by default to keep the response small.'),
      },
    },
    async ({ modelPath, full }) => {
      try {
        const model = await readSemanticModel(modelPath);
        const inventory = classify(model);

        return json({
          modelPath,
          dateTable: inventory.dateTable,
          dateColumn: inventory.dateColumn,
          kpiCandidates: inventory.kpiCandidates.slice(0, 12),
          categoryCandidates: inventory.categoryCandidates.slice(0, 25),
          notes: inventory.notes,
          tables: model.tables.map((t) => ({
            name: t.name,
            hidden: t.hidden,
            measures: t.measures.filter((m) => !m.hidden).map((m) => m.name),
            columns: full
              ? t.columns.filter((c) => !c.hidden).map((c) => ({ name: c.name, dataType: c.dataType }))
              : t.columns.filter((c) => !c.hidden).length,
          })),
        });
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'list_blueprints',
    {
      title: 'List layout blueprints',
      description:
        'Return the available page blueprints with every slot and its exact position on the 1280x720 ' +
        'canvas. Use a blueprint rather than inventing coordinates - the grid keeps rows aligned and ' +
        'every row ending at x = 1256.',
      inputSchema: {
        name: z.string().optional().describe('Return just this blueprint.'),
      },
    },
    async ({ name }) => {
      try {
        const list = name ? [getBlueprint(name)] : Object.values(BLUEPRINTS);
        return json({
          canvas: CANVAS,
          bands: BANDS,
          grid: { widthFormula: 'width(n) = 104n - 16', xFormula: 'x(c) = 24 + 104(c - 1)' },
          blueprints: list.map((bp) => ({
            name: bp.name,
            description: bp.description,
            useWhen: bp.useWhen,
            slots: bp.slots.map((s) => ({
              slot: s.slot,
              role: s.role,
              visualType: s.visualType,
              position: s.position,
              purpose: s.purpose,
              optional: s.optional ?? false,
            })),
          })),
        });
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'list_visual_types',
    {
      title: 'List supported visual types',
      description:
        'Return the visual types this server can bind, with the queryState roles each one accepts, plus ' +
        'the types whose role names vary between Power BI versions and therefore have to be harvested ' +
        'from a real report before use.',
      inputSchema: {},
    },
    async () =>
      json({
        verified: ROLES,
        unverified: [...UNVERIFIED_TYPES],
        note:
          'For an unverified type, author one in Power BI Desktop, save as PBIP, run ' +
          'harvest-visual-schema.ps1 over it, then pass the harvested role names to add_visual.',
      }),
  );

  // -------------------------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    'create_report',
    {
      title: 'Create a report',
      description:
        'Scaffold a PBIP report folder with one empty page, bound to a semantic model. Pass modelPath ' +
        'for local development, or semanticModelId to target a model in a Fabric workspace (required ' +
        'for deployment - a byPath report cannot be published).',
      inputSchema: {
        name: z.string().describe('Report name. Becomes <name>.Report, <name>.pbip and the item displayName.'),
        outputPath: z.string().describe('Folder that will contain the report folder and .pbip file.'),
        modelPath: z
          .string()
          .optional()
          .describe('Path to the semantic model folder, relative to the .Report folder, e.g. "../Sales.SemanticModel".'),
        semanticModelId: z.string().optional().describe('GUID of a semantic model in a Fabric workspace.'),
        pageName: z.string().optional().describe('Display name of the first page. Defaults to "Overview".'),
        force: z.boolean().optional().describe('Overwrite an existing report folder.'),
        theme: z.object(themeOptions).optional().describe('Look and feel. Omit for the default light theme.'),
      },
    },
    async (args) => {
      try {
        const result = await createReport(args as any);
        return json({
          ...result,
          next: 'Call apply_blueprint to fill the page, or add_visual for one visual at a time.',
        });
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'add_page',
    {
      title: 'Add a page',
      description:
        'Add a page to an existing report and register it in pages.json. A page that is not registered ' +
        'renders nowhere, so always add pages through this tool rather than by writing files.',
      inputSchema: {
        reportPath: z.string(),
        pageFolder: z.string().describe('Folder name for the page. Keep it readable, e.g. "detail".'),
        displayName: z.string().describe('Page tab caption.'),
        makeActive: z.boolean().optional().describe('Make this the landing page.'),
      },
    },
    async ({ reportPath, pageFolder, displayName, makeActive }) => {
      try {
        const result = await addPage(reportPath, pageFolder, displayName, makeActive ?? false);
        return json(result);
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'set_theme',
    {
      title: 'Set the report theme',
      description:
        'Write or replace the report theme: page background, card colour, corner radius, shadow, ' +
        'palette and fonts. Reach for this when a report looks flat - Power BI defaults to white ' +
        'cards on a white page, so nothing has an edge. A tinted canvas behind white cards is what ' +
        'makes visuals read as panels. Theme JSON is applied by Desktop and fails benignly, so it is ' +
        'far safer to adjust than per-visual formatting.',
      inputSchema: {
        reportPath: z.string(),
        ...themeOptions,
      },
    },
    async ({ reportPath, ...theme }) => {
      try {
        const file = await writeTheme(reportPath, theme as any);
        const preset = (theme.preset ?? 'light') as ThemePreset;
        return text(
          [
            `Theme written to ${file}`,
            `preset: ${preset}${theme.accent ? `, accent: ${theme.accent}` : ''}`,
            '',
            'Reopen the report in Power BI Desktop to see it. A theme change needs no data refresh.',
          ].join('\n'),
        );
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'list_theme_presets',
    {
      title: 'List theme presets',
      description:
        'Return the available theme presets and the options set_theme accepts, so a look can be ' +
        'chosen without guessing at Power BI theme JSON.',
      inputSchema: {},
    },
    async () =>
      json({
        presets: THEME_PRESETS,
        notes: [
          'light is the default: white cards on #F5F6FA, 8px radius, soft shadow.',
          'dark uses light text on near-black with a brighter palette.',
          'minimal removes fills and shadows; separation comes from whitespace.',
          'accent leads the palette; dataColors replaces it outright.',
          'Every colour is a 6-digit hex string.',
        ],
      }),
  );

  server.registerTool(
    'apply_blueprint',
    {
      title: 'Apply a blueprint to a page',
      description:
        'Fill a page with a whole laid-out set of bound visuals in one call: title, KPI row, charts and ' +
        'detail, positioned by the blueprint. Slots the assignment cannot fill are skipped with a reason ' +
        'rather than emitted empty. This is the fastest path from a semantic model to a finished page.',
      inputSchema: {
        reportPath: z.string(),
        blueprint: z.enum(['executive-overview', 'trend-analysis', 'comparison', 'detail-table']),
        title: z.string().describe('Dashboard title, shown in the header textbox.'),
        kpiMeasures: z.array(fieldRef).max(4).describe('Up to four headline measures for the KPI row.'),
        pageFolder: z.string().optional().describe('Target page. Defaults to the only page when there is just one.'),
        dateField: fieldRef.optional().describe('Date column from the date table. Without it, time-based slots are skipped.'),
        primaryMeasure: fieldRef.optional().describe('The measure charts plot. Defaults to the first KPI measure.'),
        primaryCategory: fieldRef.optional().describe('Main category column, for the breakdown chart.'),
        secondaryCategory: fieldRef.optional().describe('Second category, for composition and comparison slots. Keep it under 7 distinct values.'),
        detailFields: z.array(fieldRef).optional().describe('Columns and measures for the detail table, in display order.'),
        overwrite: z.boolean().optional().describe('Replace visuals that already occupy these slots.'),
      },
    },
    async (args) => {
      try {
        const pageFolder = await resolvePageFolder(args.reportPath, args.pageFolder);
        const result = await applyBlueprint(
          args.reportPath,
          pageFolder,
          args.blueprint,
          {
            title: args.title,
            kpiMeasures: args.kpiMeasures,
            dateField: args.dateField,
            primaryMeasure: args.primaryMeasure,
            primaryCategory: args.primaryCategory,
            secondaryCategory: args.secondaryCategory,
            detailFields: args.detailFields,
          },
          args.overwrite ?? false,
        );

        const lines = [
          `Applied '${result.blueprint}' to page '${result.pageFolder}'.`,
          '',
          `Written (${result.applied.length}):`,
          ...result.applied.map(
            (a) =>
              `  ${a.slot} (${a.visualType})` +
              (Object.keys(a.bindings).length > 0
                ? ` — ${Object.entries(a.bindings)
                    .map(([role, fields]) => `${role}: ${describeFields(fields)}`)
                    .join('; ')}`
                : ''),
          ),
        ];
        if (result.skipped.length > 0) {
          lines.push('', `Skipped (${result.skipped.length}):`);
          lines.push(...result.skipped.map((s) => `  ${s.slot} — ${s.reason}`));
        }
        lines.push('', 'Next: preview_report to see the layout, then validate_report.');
        return text(lines.join('\n'));
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'add_visual',
    {
      title: 'Add a visual',
      description:
        'Write one bound visual. Give it a position either by naming a blueprint slot or by passing ' +
        'explicit coordinates. Bindings are given as role -> fields; the server builds the queryState, ' +
        'projections and literal encodings, and rejects a role the visual type does not accept.',
      inputSchema: {
        reportPath: z.string(),
        visualFolder: z.string().describe('Folder name for the visual. Keep it readable, e.g. "salesByRegion".'),
        visualType: z.string().describe('e.g. barChart, lineChart, cardVisual, tableEx, slicer, textbox.'),
        pageFolder: z.string().optional(),
        slot: z
          .object({ blueprint: z.string(), slot: z.string() })
          .optional()
          .describe('Take the position from this blueprint slot.'),
        position: position.optional().describe('Explicit position. Use the grid: width = 104n - 16, x = 24 + 104(c-1).'),
        bindings: z
          .record(z.string(), z.array(fieldRef))
          .optional()
          .describe('Role name -> fields, e.g. {"Category":[...],"Y":[...]}. Call list_visual_types for accepted roles.'),
        title: z.string().nullable().optional().describe('Container title. Pass null to hide it; omit for the Power BI default.'),
        textContent: z.string().optional().describe('textbox only: the text to display.'),
        slicerMode: z.enum(['Between', 'Dropdown', 'Basic']).optional().describe('slicer only. Use Between for dates.'),
        sortBy: z
          .object({
            table: z.string(),
            field: z.string(),
            kind: z.enum(['Measure', 'Column']).optional(),
            direction: z.enum(['Ascending', 'Descending']).optional(),
          })
          .optional()
          .describe('Sort the visual by one of its bound fields. Use it on any ranked bar chart.'),
        overwrite: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const pageFolder = await resolvePageFolder(args.reportPath, args.pageFolder);

        let pos;
        if (args.slot) {
          pos = getSlot(args.slot.blueprint, args.slot.slot).position;
        } else if (args.position) {
          pos = {
            x: args.position.x,
            y: args.position.y,
            width: args.position.width,
            height: args.position.height,
            z: args.position.z ?? 1000,
            tabOrder: args.position.tabOrder ?? 1000,
          };
        } else {
          return fail('Pass either slot (blueprint + slot name) or position.');
        }

        const result = await writeVisual({
          reportPath: args.reportPath,
          pageFolder,
          visualFolder: args.visualFolder,
          visualType: args.visualType,
          position: pos,
          bindings: args.bindings,
          title: args.title,
          text: args.textContent,
          slicerMode: args.slicerMode,
          sortBy: args.sortBy,
          overwrite: args.overwrite ?? false,
        });

        return json({ ...result, pageFolder, position: pos });
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'remove_visual',
    {
      title: 'Remove a visual',
      description:
        'Delete a visual from a page. Prefer this over leaving an unwanted visual in place: a slot with ' +
        'nothing useful to show reads worse than an empty gap, and nothing else in the report references ' +
        'a visual by name, so removal is safe.',
      inputSchema: {
        reportPath: z.string(),
        visualFolder: z.string(),
        pageFolder: z.string().optional(),
      },
    },
    async ({ reportPath, visualFolder, pageFolder }) => {
      try {
        const folder = await resolvePageFolder(reportPath, pageFolder);
        await removeVisual(reportPath, folder, visualFolder);
        return text(`Removed '${visualFolder}' from page '${folder}'.`);
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  // -------------------------------------------------------------------------------------------
  // Inspection and checking
  // -------------------------------------------------------------------------------------------

  server.registerTool(
    'describe_report',
    {
      title: 'Describe a report',
      description:
        'Return the structure of an existing PBIR report: model binding, pages, and every visual with ' +
        'its position and field bindings. Call this before editing a report you did not just create.',
      inputSchema: { reportPath: z.string() },
    },
    async ({ reportPath }) => {
      try {
        return json(await readReport(reportPath));
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'preview_report',
    {
      title: 'Preview the layout',
      description:
        'Render the report as an HTML wireframe - one to-scale SVG per page, each visual a labelled box ' +
        'showing its type and bindings, with overlapping, off-canvas and unbound visuals outlined in red. ' +
        'Read the returned summary after generating: writing coordinates blind is how a page ends up ' +
        'technically valid and visually wrong.',
      inputSchema: {
        reportPath: z.string(),
        outputPath: z.string().optional().describe('Where to write the HTML. Defaults to beside the report folder.'),
        pageFolder: z.string().optional().describe('Render only this page.'),
      },
    },
    async ({ reportPath, outputPath, pageFolder }) => {
      try {
        const result = await writePreview(reportPath, outputPath, pageFolder);
        const report = await readReport(reportPath);

        const layout = report.pages
          .filter((p) => !pageFolder || p.folder === pageFolder)
          .map((p) => {
            const rows = p.visuals
              .map((v) => {
                const bindings = Object.entries(v.bindings)
                  .map(([role, fields]) => `${role}: ${describeFields(fields)}`)
                  .join('; ');
                return `    ${v.folder} (${v.visualType}) at ${Math.round(v.position.x)},${Math.round(
                  v.position.y,
                )} ${Math.round(v.position.width)}x${Math.round(v.position.height)}${bindings ? ` — ${bindings}` : ''}`;
              })
              .join('\n');
            return `  ${p.displayName} [${p.folder}]\n${rows || '    (no visuals)'}`;
          })
          .join('\n');

        return text(
          [
            `Wireframe written to ${result.outputPath}`,
            `${result.pages} page(s), ${result.visuals} visual(s), ${result.issues} issue(s).`,
            '',
            layout,
            '',
            result.issues > 0
              ? 'Open the HTML to see what is flagged, or call validate_report for the rule names.'
              : 'Layout looks clean. Open the HTML to judge whether it reads well.',
          ].join('\n'),
        );
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'validate_report',
    {
      title: 'Validate a report',
      description:
        'Check structure, page indexing, visual bindings, geometry, and - when modelPath is given - that ' +
        'every field reference resolves against the model TMDL. Errors mean the report is broken; ' +
        'warnings mean it opens but probably reads badly. Run this before handing a report over.',
      inputSchema: {
        reportPath: z.string(),
        modelPath: z.string().optional().describe('Path to the semantic model folder, to check field references.'),
      },
    },
    async ({ reportPath, modelPath }) => {
      try {
        const result = await validateReport(reportPath, modelPath);
        const body = formatFindings(result);
        return result.errors > 0 ? { content: [{ type: 'text' as const, text: body }], isError: true } : text(body);
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'rebind_report',
    {
      title: 'Rebind to another semantic model',
      description:
        'Point the report at a different model. Use modelPath for a local folder, or semanticModelId for ' +
        'a workspace model - the latter is required before deploying, because a byPath report cannot be ' +
        'published. Validate afterwards: field references are not rewritten.',
      inputSchema: {
        reportPath: z.string(),
        modelPath: z.string().optional(),
        semanticModelId: z.string().optional(),
      },
    },
    async ({ reportPath, modelPath, semanticModelId }) => {
      try {
        if (!modelPath && !semanticModelId) return fail('Pass either modelPath or semanticModelId.');
        if (modelPath && semanticModelId) return fail('modelPath and semanticModelId are mutually exclusive.');

        const { readJson, writeJson } = await import('./pbir.js');
        const file = path.join(reportPath, 'definition.pbir');
        const pbir = await readJson<any>(file);

        pbir.datasetReference = semanticModelId
          ? { byConnection: { connectionString: `semanticmodelid=${semanticModelId}` } }
          : { byPath: { path: modelPath } };

        await writeJson(file, pbir);
        return text(
          `Rebound to ${semanticModelId ? `byConnection semanticmodelid=${semanticModelId}` : `byPath ${modelPath}`}. ` +
            'Run validate_report against the new model to catch field references it does not satisfy.',
        );
      } catch (err: any) {
        return fail(err.message);
      }
    },
  );

  return server;
}

export { gridWidth, gridX };
