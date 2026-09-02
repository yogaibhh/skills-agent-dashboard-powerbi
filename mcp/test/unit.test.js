/**
 * Unit tests for the generation core. Run with `npm test` (builds first).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createReport, addPage, readReport, projection, queryState, readBindings } from '../dist/pbir.js';
import { buildVisual, writeVisual, ROLES } from '../dist/visuals.js';
import { gridWidth, gridX, BLUEPRINTS, getSlot, registerBlueprint } from '../dist/blueprints.js';
import { readSemanticModel, classify, resolveField } from '../dist/tmdl.js';
import { applyBlueprint } from '../dist/generate.js';
import { validateReport } from '../dist/validate.js';
import { renderPreview } from '../dist/preview.js';
import { buildTheme, buildPageObjects, resolvePalette, THEME_PRESETS } from '../dist/theme.js';
import { writeTheme } from '../dist/pbir.js';
import { saveTemplate, loadTemplates, snapToGrid, harvestLayout } from '../dist/layout.js';
import { buildTopNFilter } from '../dist/filters.js';

const M = (table, field) => ({ table, field, kind: 'Measure' });
const C = (table, field) => ({ table, field, kind: 'Column' });

async function tempDir(label) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `pbi-mcp-${label}-`));
}

async function writeModel(root) {
  const tables = path.join(root, 'Sales.SemanticModel', 'definition', 'tables');
  await fs.mkdir(tables, { recursive: true });
  await fs.writeFile(
    path.join(tables, 'Sales.tmdl'),
    [
      'table Sales',
      "\tmeasure 'Total Sales' = SUM(Sales[Amount])",
      '\t\tformatString: #,0',
      "\tmeasure 'Total Orders' = COUNTROWS(Sales)",
      "\tmeasure '_Internal Helper' = 1",
      '\t\tdisplayFolder: Internal',
      '\tcolumn Amount',
      '\t\tdataType: double',
      '\tcolumn CustomerKey',
      '\t\tdataType: int64',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(tables, 'Date.tmdl'),
    ['table Date', '\tdataCategory: Time', '\tcolumn Date', '\t\tdataType: dateTime', '\tcolumn Year', '\t\tdataType: int64', ''].join('\n'),
  );
  await fs.writeFile(
    path.join(tables, 'Product.tmdl'),
    ['table Product', '	column Category', '		dataType: string', '	column ProductName', '		dataType: string', '	column ProductNo', '		dataType: string', '	column ProductKey', '		dataType: int64', ''].join('\n'),
  );
  return path.join(root, 'Sales.SemanticModel');
}

// ---------------------------------------------------------------------------------------------

test('grid formulas produce rows that end at 1256', () => {
  assert.equal(gridWidth(12), 1232);
  assert.equal(gridX(1), 24);
  assert.equal(gridX(1) + gridWidth(12), 1256);
  assert.equal(gridX(9) + gridWidth(4), 1256);
  assert.equal(gridX(7) + gridWidth(6), 1256);
});

test('every blueprint slot sits on the grid and inside the canvas', () => {
  for (const bp of Object.values(BLUEPRINTS)) {
    for (const slot of bp.slots) {
      const { x, y, width, height } = slot.position;
      assert.ok(x + width <= 1256.5, `${bp.name}/${slot.slot} ends at ${x + width}`);
      assert.ok(y + height <= 696.5, `${bp.name}/${slot.slot} bottom is ${y + height}`);
      assert.equal((x - 24) % 104, 0, `${bp.name}/${slot.slot} x=${x} is off-grid`);
      assert.equal((width + 16) % 104, 0, `${bp.name}/${slot.slot} width=${width} is off-grid`);
    }
  }
});

test('no blueprint places two visuals on top of each other', () => {
  for (const bp of Object.values(BLUEPRINTS)) {
    const slots = bp.slots;
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = slots[i].position;
        const b = slots[j].position;
        const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        assert.ok(ox <= 1 || oy <= 1, `${bp.name}: ${slots[i].slot} overlaps ${slots[j].slot}`);
      }
    }
  }
});

test('active marks the leading column of a role and never a measure', () => {
  // Verified against a Desktop-authored report: measures carry no `active`, and on a Category
  // holding several columns only the first does - that is the top of the drill hierarchy.
  const measuresOnly = queryState({ Y: [M('Sales', 'Total Sales'), M('Sales', 'Total Orders')] });
  assert.equal(measuresOnly.Y.projections[0].active, undefined);
  assert.equal(measuresOnly.Y.projections[1].active, undefined);

  const drill = queryState({ Category: [C('Date', 'Year'), C('Date', 'Quarter'), C('Date', 'Month')] });
  assert.equal(drill.Category.projections[0].active, true);
  assert.equal(drill.Category.projections[1].active, undefined);
  assert.equal(drill.Category.projections[2].active, undefined);
});

test('a drill hierarchy is several columns in one role', () => {
  const visual = buildVisual({
    visualType: 'lineChart',
    position: { x: 0, y: 0, z: 0, width: 400, height: 200, tabOrder: 0 },
    bindings: { Category: [C('Date', 'Year'), C('Date', 'Quarter')], Y: [M('Sales', 'Total Sales')] },
  });
  const cat = visual.visual.query.queryState.Category.projections;
  assert.equal(cat.length, 2);
  assert.equal(cat[0].active, true);
  assert.equal(visual.visual.query.queryState.Y.projections[0].active, undefined);
});

test('projection builds the queryRef Power BI expects', () => {
  const p = projection(C('Product', 'Category'), true);
  assert.equal(p.queryRef, 'Product.Category');
  assert.equal(p.nativeQueryRef, 'Category');
  assert.equal(p.field.Column.Expression.SourceRef.Entity, 'Product');
  assert.equal(p.field.Column.Property, 'Category');
});

test('bindings survive a round trip through visual.json', () => {
  const bindings = { Category: [C('Product', 'Category')], Y: [M('Sales', 'Total Sales')] };
  const visual = buildVisual({ visualType: 'barChart', position: { x: 0, y: 0, z: 0, width: 100, height: 100, tabOrder: 0 }, bindings });
  assert.deepEqual(readBindings(visual), bindings);
});

test('a role the visual type does not accept is rejected', () => {
  assert.throws(
    () =>
      buildVisual({
        visualType: 'donutChart',
        position: { x: 0, y: 0, z: 0, width: 100, height: 100, tabOrder: 0 },
        bindings: { Rows: [C('Product', 'Category')] },
      }),
    /does not accept role 'Rows'/,
  );
});

test('literal encoding carries the type suffix', () => {
  const card = buildVisual({
    visualType: 'cardVisual',
    position: { x: 0, y: 0, z: 0, width: 100, height: 100, tabOrder: 0 },
    bindings: { Data: [M('Sales', 'Total Sales'), M('Sales', 'Total Orders')] },
  });
  const layout = card.visual.objects.layout[0].properties;
  assert.equal(layout.columnCount.expr.Literal.Value, '2L');
  assert.equal(layout.alignment.expr.Literal.Value, "'middle'");
  assert.equal(card.visual.visualContainerObjects, undefined);
});

test('a title becomes a quoted literal, and null hides the title', () => {
  const pos = { x: 0, y: 0, z: 0, width: 100, height: 100, tabOrder: 0 };
  const withTitle = buildVisual({
    visualType: 'barChart',
    position: pos,
    bindings: { Category: [C('Product', 'Category')], Y: [M('Sales', 'Total Sales')] },
    title: "Bob's sales",
  });
  // Single quotes inside a literal have to be doubled or the expression is malformed.
  assert.equal(withTitle.visual.visualContainerObjects.title[0].properties.text.expr.Literal.Value, "'Bob''s sales'");

  const hidden = buildVisual({ visualType: 'textbox', position: pos, text: 'Hi', title: null });
  assert.equal(hidden.visual.visualContainerObjects.title[0].properties.show.expr.Literal.Value, 'false');
});

test('visual names are unique', () => {
  const pos = { x: 0, y: 0, z: 0, width: 100, height: 100, tabOrder: 0 };
  const names = new Set();
  for (let i = 0; i < 200; i++) {
    names.add(buildVisual({ visualType: 'textbox', position: pos, text: 'x' }).name);
  }
  assert.equal(names.size, 200);
  for (const name of names) assert.match(name, /^[0-9a-f]{20}$/);
});

test('every verified visual type has at least one role, except decorations', () => {
  for (const [type, roles] of Object.entries(ROLES)) {
    if (type === 'textbox' || type === 'image') assert.equal(roles.length, 0);
    else assert.ok(roles.length > 0, `${type} has no roles`);
  }
});

test('every theme preset separates the page from the cards', () => {
  // The default Power BI look is white cards on a white page, which erases every visual edge.
  // A preset that does not move one of the two is not doing its job.
  for (const preset of THEME_PRESETS) {
    const theme = buildTheme({ preset });
    const page = theme.visualStyles.page['*'].background[0].color.solid.color;
    const card = theme.visualStyles['*']['*'].background[0].color.solid.color;
    if (preset === 'minimal') {
      // minimal separates by whitespace, so it is allowed to match - but it must drop the shadow.
      assert.equal(theme.visualStyles['*']['*'].dropShadow[0].show, false);
    } else {
      assert.notEqual(page, card, `${preset}: page and card colours are identical`);
    }
    assert.equal(theme.dataColors.length, 8);
    assert.ok(theme.textClasses.callout.fontSize > theme.textClasses.label.fontSize);
  }
});

function pageFill(pageJson) {
  return pageJson.objects?.background?.[0]?.properties?.color?.solid?.color?.expr?.Literal?.Value;
}

test('a scaffolded page paints its own canvas, not just the theme', async () => {
  // The theme's visualStyles.page covers this only while that theme file is applied. A page left
  // white loses the whole look the moment someone loads a different theme.
  const root = await tempDir('canvas');
  await writeModel(root);
  const created = await createReport({
    name: 'Canvas',
    outputPath: root,
    modelPath: '../Sales.SemanticModel',
    theme: { preset: 'corporate' },
  });

  const page = JSON.parse(
    await fs.readFile(path.join(created.reportPath, 'definition', 'pages', created.pageFolder, 'page.json'), 'utf8'),
  );
  const palette = resolvePalette({ preset: 'corporate' });
  assert.equal(pageFill(page), `'${palette.page}'`);
  assert.ok(page.objects.outspace, 'outspace should be painted too');
});

test('set_theme repaints every page, and a page added later matches', async () => {
  const root = await tempDir('repaint');
  await writeModel(root);
  const created = await createReport({ name: 'Repaint', outputPath: root, modelPath: '../Sales.SemanticModel' });
  await addPage(created.reportPath, 'second', 'Second');

  const result = await writeTheme(created.reportPath, { preset: 'dark' });
  assert.equal(result.pagesRepainted, 2, 'both pages should have been repainted');

  const dark = resolvePalette({ preset: 'dark' });
  for (const folder of [created.pageFolder, 'second']) {
    const page = JSON.parse(
      await fs.readFile(path.join(created.reportPath, 'definition', 'pages', folder, 'page.json'), 'utf8'),
    );
    assert.equal(pageFill(page), `'${dark.page}'`, `${folder} was not repainted`);
  }

  // A page created after the theme change should adopt it without being told.
  await addPage(created.reportPath, 'third', 'Third');
  const third = JSON.parse(
    await fs.readFile(path.join(created.reportPath, 'definition', 'pages', 'third', 'page.json'), 'utf8'),
  );
  assert.equal(pageFill(third), `'${dark.page}'`, 'a new page should match the report theme');
});

test('repainting preserves other page objects', async () => {
  const root = await tempDir('preserve');
  await writeModel(root);
  const created = await createReport({ name: 'Preserve', outputPath: root, modelPath: '../Sales.SemanticModel' });

  const pageFile = path.join(created.reportPath, 'definition', 'pages', created.pageFolder, 'page.json');
  const page = JSON.parse(await fs.readFile(pageFile, 'utf8'));
  page.objects.outspacePane = [{ properties: { width: { expr: { Literal: { Value: '257L' } } } } }];
  await fs.writeFile(pageFile, JSON.stringify(page, null, 2), 'utf8');

  await writeTheme(created.reportPath, { preset: 'warm' });
  const after = JSON.parse(await fs.readFile(pageFile, 'utf8'));
  assert.ok(after.objects.outspacePane, 'an unrelated page object was dropped by the repaint');
  assert.equal(pageFill(after), `'${resolvePalette({ preset: 'warm' }).page}'`);
});

test('page objects use the literal encoding PBIR expects', () => {
  // Verified against the official page/1.4.0 schema: objects.background is an array of
  // { properties: { color, transparency } }, and colours are expression-wrapped, not plain strings.
  const objects = buildPageObjects(resolvePalette({ preset: 'light' }));
  assert.ok(Array.isArray(objects.background));
  assert.match(objects.background[0].properties.color.solid.color.expr.Literal.Value, /^'#[0-9A-F]{6}'$/i);
  assert.equal(objects.background[0].properties.transparency.expr.Literal.Value, '0D');
});

test('an accent leads the palette without duplicating a preset colour', () => {
  const theme = buildTheme({ accent: '#2C5F9E' });
  assert.equal(theme.dataColors[0], '#2C5F9E');
  assert.equal(new Set(theme.dataColors).size, theme.dataColors.length, 'palette has a duplicate');
});

test('bad theme input is rejected rather than written', () => {
  assert.throws(() => buildTheme({ accent: 'blue' }), /hex/);
  assert.throws(() => buildTheme({ dataColors: ['#fff'] }), /hex/);
  assert.throws(() => buildTheme({ cornerRadius: 99 }), /between 0 and 40/);
  assert.throws(() => buildTheme({ preset: 'neon' }), /Unknown theme preset/);
});

// ---------------------------------------------------------------------------------------------

test('TMDL reader finds tables, measures and columns', async () => {
  const root = await tempDir('tmdl');
  const modelPath = await writeModel(root);
  const model = await readSemanticModel(modelPath);

  assert.equal(model.tables.length, 3);
  const sales = model.tables.find((t) => t.name === 'Sales');
  assert.deepEqual(
    sales.measures.map((m) => m.name).sort(),
    ['Total Orders', 'Total Sales', '_Internal Helper'],
  );
  const date = model.tables.find((t) => t.name === 'Date');
  assert.equal(date.dataCategory, 'Time');
  assert.equal(date.columns.find((c) => c.name === 'Date').dataType, 'dateTime');
});

test('classification finds the date table and filters internal measures out of KPI candidates', async () => {
  const root = await tempDir('classify');
  const model = await readSemanticModel(await writeModel(root));
  const inventory = classify(model);

  assert.equal(inventory.dateTable, 'Date');
  assert.equal(inventory.dateColumn, 'Date');

  const kpiNames = inventory.kpiCandidates.map((k) => k.measure);
  assert.ok(kpiNames.includes('Total Sales'));
  assert.ok(!kpiNames.includes('_Internal Helper'), 'measures in an Internal folder should not be KPI candidates');

  const categories = inventory.categoryCandidates.map((c) => `${c.table}.${c.column}`);
  assert.ok(categories.includes('Product.Category'));
  assert.ok(!categories.some((c) => c.endsWith('Key')), 'key columns are not categories');
});

test('a KPI slot uses the role its visual type accepts', async () => {
  // Regression from a harvested template: planSlot always emitted Data, but only cardVisual takes
  // Data - card and multiRowCard take Values. A public layout using multiRowCard was rejected by the
  // very validation meant to protect it.
  const root = await tempDir('cardrole');
  const modelPath = await writeModel(root);
  const created = await createReport({ name: 'CardRole', outputPath: root, modelPath: '../Sales.SemanticModel' });

  registerBlueprint({
    name: 'multi-row-kpi',
    description: 'test',
    useWhen: 'test',
    slots: [
      {
        slot: 'kpiRow',
        role: 'kpiRow',
        visualType: 'multiRowCard',
        position: { x: 24, y: 88, z: 5000, width: 1232, height: 112, tabOrder: 5000 },
        purpose: 'test',
      },
    ],
  });

  const result = await applyBlueprint(created.reportPath, created.pageFolder, 'multi-row-kpi', {
    title: 'x',
    kpiMeasures: [M('Sales', 'Total Sales')],
  });
  assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
  assert.deepEqual(Object.keys(result.applied[0].bindings), ['Values']);

  const validation = await validateReport(created.reportPath, modelPath);
  assert.equal(validation.errors, 0, JSON.stringify(validation.findings));
});

test('harvesting rescales a 1920x1080 page instead of clamping it', async () => {
  // Most published reports are authored at 1920x1080, not the 1280x720 the blueprints use. Snapping
  // those coordinates straight onto a 1280 grid does not adapt the layout, it amputates it: a visual
  // at x=1500 lands on the right margin. Measured across 73 public pages, this took median snap
  // drift from 648px to 56px.
  const root = await tempDir('rescale');
  await writeModel(root);
  const created = await createReport({ name: 'Wide', outputPath: root, modelPath: '../Sales.SemanticModel' });

  const pageFile = path.join(created.reportPath, 'definition', 'pages', created.pageFolder, 'page.json');
  const page = JSON.parse(await fs.readFile(pageFile, 'utf8'));
  page.width = 1920;
  page.height = 1080;
  await fs.writeFile(pageFile, JSON.stringify(page, null, 2), 'utf8');

  // A visual filling the right half of a 1920 canvas.
  await writeVisual({
    reportPath: created.reportPath,
    pageFolder: created.pageFolder,
    visualFolder: 'wide',
    visualType: 'barChart',
    position: { x: 960, y: 540, z: 1000, width: 900, height: 480, tabOrder: 1000 },
    bindings: { Category: [C('Product', 'Category')], Y: [M('Sales', 'Total Sales')] },
  });
  await writeVisual({
    reportPath: created.reportPath,
    pageFolder: created.pageFolder,
    visualFolder: 'header',
    visualType: 'textbox',
    position: { x: 40, y: 30, z: 9000, width: 800, height: 80, tabOrder: 9000 },
    text: 'Wide',
  });

  const [harvested] = await harvestLayout(created.reportPath);
  // Slots are named by inferred role, not by the source folder name.
  const wide = harvested.blueprint.slots.find((s) => s.visualType === 'barChart');

  // 960 of 1920 is the horizontal midpoint; it must land near the midpoint of 1280, not at the margin.
  assert.ok(wide.position.x > 560 && wide.position.x < 700, `expected the midpoint, got x=${wide.position.x}`);
  assert.ok(wide.position.x + wide.position.width <= 1256, 'rescaled visual runs past the right margin');
  assert.ok(wide.position.y + wide.position.height <= 696, 'rescaled visual runs past the bottom margin');
  assert.ok(harvested.maxDrift <= 60, `drift ${harvested.maxDrift} suggests clamping rather than scaling`);
  assert.ok(
    harvested.warnings.some((w) => w.includes('rescaled by')),
    'a rescale should be reported, not silent',
  );
});

test('a Top-N filter matches the shape harvested from real reports', () => {
  // Structure taken from eleven TopN filters across four public MIT reports. The filter is a
  // subquery that ranks the category by the measure, takes the top N, and constrains the visual to
  // the members it returned - not a property anyone would guess.
  const filter = buildTopNFilter({
    category: C('Product', 'Category'),
    measure: M('Sales', 'Total Sales'),
    top: 10,
  });

  assert.equal(filter.type, 'TopN');
  assert.match(filter.name, /^[0-9a-f]{20}$/);
  assert.equal(filter.field.Column.Expression.SourceRef.Entity, 'Product');

  const query = filter.filter.From[0].Expression.Subquery.Query;
  assert.equal(query.Top, 10);
  assert.equal(query.OrderBy[0].Direction, 2, 'Descending is encoded as 2');
  assert.equal(query.OrderBy[0].Expression.Measure.Property, 'Total Sales');

  // Two tables, so two aliases, and the measure is read through its own.
  assert.deepEqual(query.From.map((f) => f.Name), ['c', 'm']);
  assert.equal(query.OrderBy[0].Expression.Measure.Expression.SourceRef.Source, 'm');

  // The visual is constrained by an In against the subquery.
  assert.equal(filter.filter.Where[0].Condition.In.Table.SourceRef.Source, 'subquery');
  assert.equal(filter.filter.From[1].Entity, 'Product');
});

test('a same-table Top-N collapses to one alias', () => {
  const filter = buildTopNFilter({
    category: C('Sales', 'Country'),
    measure: M('Sales', 'Total Sales'),
    top: 5,
  });
  const query = filter.filter.From[0].Expression.Subquery.Query;
  assert.deepEqual(query.From.map((f) => f.Name), ['c']);
  assert.equal(query.OrderBy[0].Expression.Measure.Expression.SourceRef.Source, 'c');
});

test('Top-N rejects input that would produce a broken filter', () => {
  const cat = C('Product', 'Category');
  const meas = M('Sales', 'Total Sales');
  assert.throws(() => buildTopNFilter({ category: cat, measure: meas, top: 0 }), /positive whole number/);
  assert.throws(() => buildTopNFilter({ category: cat, measure: meas, top: 2.5 }), /positive whole number/);
  assert.throws(() => buildTopNFilter({ category: meas, measure: meas, top: 5 }), /pass a Column/);
  assert.throws(() => buildTopNFilter({ category: cat, measure: cat, top: 5 }), /pass a Measure/);
});

test('topN lands at the root of visual.json, beside position', () => {
  // Every harvested example had filterConfig at the root, not inside `visual`. Putting it in the
  // wrong place is the sortDefinition mistake again.
  const visual = buildVisual({
    visualType: 'barChart',
    position: { x: 24, y: 216, z: 1000, width: 400, height: 232, tabOrder: 1000 },
    bindings: { Category: [C('Product', 'Category')], Y: [M('Sales', 'Total Sales')] },
    topN: { count: 10 },
  });

  assert.ok(visual.filterConfig, 'filterConfig must be at the root');
  assert.equal(visual.visual.filterConfig, undefined, 'filterConfig must not be inside visual');
  assert.equal(visual.filterConfig.filters[0].filter.From[0].Expression.Subquery.Query.Top, 10);
  // The ranking measure is taken from what the visual already plots.
  assert.equal(
    visual.filterConfig.filters[0].filter.From[0].Expression.Subquery.Query.OrderBy[0].Expression.Measure.Property,
    'Total Sales',
  );
});

test('topN without something to rank is refused rather than half-written', () => {
  const pos = { x: 0, y: 0, z: 0, width: 400, height: 232, tabOrder: 0 };
  assert.throws(
    () => buildVisual({ visualType: 'barChart', position: pos, bindings: { Y: [M('Sales', 'Total Sales')] }, topN: { count: 5 } }),
    /needs a Category/,
  );
  assert.throws(
    () => buildVisual({ visualType: 'barChart', position: pos, bindings: { Category: [C('Product', 'Category')] }, topN: { count: 5 } }),
    /needs a measure/,
  );
});

test('a saved template carries no absolute path', async () => {
  // Templates are meant to be shared and committed. An absolute source path leaks a username and a
  // directory layout that say nothing about the layout itself.
  const dir = await tempDir('templates');
  const blueprint = {
    name: 'sample',
    description: 'x',
    useWhen: 'y',
    slots: [{ slot: 'a', role: 'title', visualType: 'textbox', position: { x: 24, y: 16, z: 1, width: 400, height: 56, tabOrder: 1 }, purpose: 'p' }],
  };
  const file = await saveTemplate(dir, blueprint, 'C:/Users/someone/Documents/Private/My Report.Report');
  const raw = await fs.readFile(file, 'utf8');

  assert.ok(!raw.includes('someone'), 'a username leaked into a shareable template');
  assert.ok(!raw.includes('C:/'), 'an absolute path leaked into a shareable template');
  assert.match(JSON.parse(raw).source, /^My Report\.Report$/);

  const { loaded, errors } = await loadTemplates(dir);
  assert.equal(errors.length, 0);
  assert.equal(loaded[0].name, 'sample');
});

test('snapping keeps a hand-drawn position on the grid and inside the canvas', () => {
  const { position, drift } = snapToGrid({ x: 426.98, y: 216.32, z: 0, width: 836.01, height: 492.16, tabOrder: 0 });
  assert.equal((position.x - 24) % 104, 0, 'x is off-grid');
  assert.equal((position.width + 16) % 104, 0, 'width is off-grid');
  assert.ok(position.x + position.width <= 1256, 'snapped past the right margin');
  assert.ok(position.y + position.height <= 696, 'snapped past the bottom margin');
  assert.ok(drift > 0 && drift < 60, `drift should be reported and modest, got ${drift}`);
});

test('identifier columns are rejected and grouping names rank first', async () => {
  // Regression from a real model: TransactionNo, ProductNo and CustomerNo are the three
  // highest-cardinality columns in a retail export, and a name-only filter ranked them as prime
  // categories. A chart built on the top pick would have had 20,000 bars.
  const root = await tempDir('rank');
  const model = await readSemanticModel(await writeModel(root));
  const inv = classify(model);

  const names = inv.categoryCandidates.map((c) => c.column);
  assert.ok(!names.includes('ProductNo'), 'a *No column is an identifier, not a category');
  assert.ok(!names.includes('ProductKey'), 'a *Key column is an identifier');

  // Category beats ProductName: one states a grouping, the other is a per-row label.
  assert.equal(inv.categoryCandidates[0].column, 'Category');
  assert.ok(names.indexOf('Category') < names.indexOf('ProductName'), 'a grouping name must outrank a label');
});

test('field resolution distinguishes missing from wrong case', async () => {
  const root = await tempDir('resolve');
  const model = await readSemanticModel(await writeModel(root));

  assert.equal(resolveField(model, 'Sales', 'Total Sales', 'Measure').ok, true);

  const wrongCase = resolveField(model, 'sales', 'Total Sales', 'Measure');
  assert.equal(wrongCase.ok, false);
  assert.match(wrongCase.message, /differs in case/);

  const missing = resolveField(model, 'Sales', 'Revenue Total', 'Measure');
  assert.equal(missing.ok, false);
  assert.match(missing.message, /does not exist/);
});

// ---------------------------------------------------------------------------------------------

test('create_report scaffolds a report that validates', async () => {
  const root = await tempDir('create');
  await writeModel(root);

  const result = await createReport({
    name: 'Sales Overview',
    outputPath: root,
    modelPath: '../Sales.SemanticModel',
  });

  assert.ok(result.reportPath.endsWith('Sales Overview.Report'));
  assert.match(result.pageName, /^[0-9a-f]{20}$/);

  const validation = await validateReport(result.reportPath);
  assert.equal(validation.errors, 0, JSON.stringify(validation.findings, null, 2));
  // One empty page is a warning, not an error.
  assert.ok(validation.findings.some((f) => f.rule === 'page-empty'));
});

test('scaffolded JSON has no byte-order mark', async () => {
  const root = await tempDir('bom');
  await writeModel(root);
  const result = await createReport({ name: 'Bom Check', outputPath: root, modelPath: '../Sales.SemanticModel' });

  for (const rel of ['.platform', 'definition.pbir', 'definition/pages/pages.json']) {
    const buffer = await fs.readFile(path.join(result.reportPath, ...rel.split('/')));
    assert.notEqual(buffer[0], 0xef, `${rel} starts with a BOM`);
  }
});

test('create_report refuses to overwrite without force', async () => {
  const root = await tempDir('force');
  await writeModel(root);
  const args = { name: 'Twice', outputPath: root, modelPath: '../Sales.SemanticModel' };
  await createReport(args);
  await assert.rejects(() => createReport(args), /already exists/);
  await createReport({ ...args, force: true });
});

test('add_page registers the page in pages.json', async () => {
  const root = await tempDir('addpage');
  await writeModel(root);
  const created = await createReport({ name: 'Multi', outputPath: root, modelPath: '../Sales.SemanticModel' });

  const added = await addPage(created.reportPath, 'detail', 'Detail');
  const report = await readReport(created.reportPath);

  assert.equal(report.pages.length, 2);
  assert.ok(report.pageOrder.includes(added.pageName));
  assert.equal(report.activePageName, created.pageName, 'adding a page should not steal the landing page');
  assert.ok(report.pages.every((p) => p.indexed));
  await assert.rejects(() => addPage(created.reportPath, 'detail', 'Detail again'), /already exists/);
});

// ---------------------------------------------------------------------------------------------

async function buildDashboard(label, assignment, blueprint = 'executive-overview') {
  const root = await tempDir(label);
  const modelPath = await writeModel(root);
  const created = await createReport({ name: 'Dash', outputPath: root, modelPath: '../Sales.SemanticModel' });
  const result = await applyBlueprint(created.reportPath, created.pageFolder, blueprint, assignment);
  return { root, modelPath, created, result };
}

const FULL_ASSIGNMENT = {
  title: 'Sales Overview',
  kpiMeasures: [M('Sales', 'Total Sales'), M('Sales', 'Total Orders')],
  dateField: C('Date', 'Date'),
  primaryCategory: C('Product', 'Category'),
  secondaryCategory: C('Product', 'Category'),
  detailFields: [C('Product', 'Category'), M('Sales', 'Total Sales')],
};

test('apply_blueprint fills every slot when the assignment is complete', async () => {
  const { created, result, modelPath } = await buildDashboard('apply', FULL_ASSIGNMENT);

  assert.equal(result.skipped.length, 0, JSON.stringify(result.skipped));
  assert.equal(result.applied.length, BLUEPRINTS['executive-overview'].slots.length);

  const validation = await validateReport(created.reportPath, modelPath);
  assert.equal(validation.errors, 0, JSON.stringify(validation.findings, null, 2));
  assert.equal(validation.warnings, 0, JSON.stringify(validation.findings, null, 2));
});

test('apply_blueprint skips slots it cannot fill instead of emitting empty visuals', async () => {
  const { created, result, modelPath } = await buildDashboard('sparse', {
    title: 'Bare',
    kpiMeasures: [M('Sales', 'Total Sales')],
    primaryCategory: C('Product', 'Category'),
  });

  const skipped = result.skipped.map((s) => s.slot);
  assert.ok(skipped.includes('dateSlicer'), 'no dateField means no date slicer');
  assert.ok(skipped.includes('trend'), 'no dateField means no trend');
  assert.ok(skipped.includes('detailTable'));
  assert.ok(result.applied.some((a) => a.slot === 'breakdown'));

  // Everything that was written is bound, so there are no empty placeholders.
  const validation = await validateReport(created.reportPath, modelPath);
  assert.equal(validation.findings.filter((f) => f.rule === 'visual-unbound').length, 0);
  assert.equal(validation.errors, 0);
});

test('sortDefinition lives inside query, not beside it', () => {
  // Regression: it used to be emitted as a sibling of query. Power BI silently degraded such a
  // visual - the sort was ignored and a table rendered only its first column. Verified placement
  // against three visuals in a Desktop-authored report.
  const visual = buildVisual({
    visualType: 'tableEx',
    position: { x: 0, y: 0, z: 0, width: 400, height: 200, tabOrder: 0 },
    bindings: { Values: [C('Product', 'Category'), M('Sales', 'Total Sales')] },
    sortBy: { table: 'Sales', field: 'Total Sales', kind: 'Measure', direction: 'Descending' },
  });

  assert.equal(visual.visual.sortDefinition, undefined, 'sortDefinition must not sit beside query');
  assert.ok(visual.visual.query.sortDefinition, 'sortDefinition must sit inside query');
  assert.deepEqual(Object.keys(visual.visual.query), ['queryState', 'sortDefinition']);
  assert.equal(visual.visual.query.sortDefinition.isDefaultSort, false);
  assert.equal(visual.visual.query.sortDefinition.sort[0].direction, 'Descending');
  assert.equal(visual.visual.query.sortDefinition.sort[0].field.Measure.Property, 'Total Sales');
});

test('a table keeps every projection it was given', () => {
  const fields = [C('Product', 'Category'), M('Sales', 'Total Sales'), M('Sales', 'Total Orders')];
  const visual = buildVisual({
    visualType: 'tableEx',
    position: { x: 0, y: 0, z: 0, width: 400, height: 200, tabOrder: 0 },
    bindings: { Values: fields },
  });
  const projections = visual.visual.query.queryState.Values.projections;
  assert.equal(projections.length, 3);
  // Matches Desktop output: active on the leading column only, never on a measure.
  assert.equal(projections[0].active, true);
  assert.equal(projections[1].active, undefined);
  assert.equal(projections[2].active, undefined);
});

test('sorting a visual with no bindings is refused', () => {
  assert.throws(
    () =>
      buildVisual({
        visualType: 'textbox',
        position: { x: 0, y: 0, z: 0, width: 100, height: 50, tabOrder: 0 },
        text: 'hi',
        sortBy: { table: 'Sales', field: 'Total Sales' },
      }),
    /cannot be sorted/,
  );
});

test('scatterChart accepts the roles harvested from a real report', () => {
  const visual = buildVisual({
    visualType: 'scatterChart',
    position: { x: 0, y: 0, z: 0, width: 400, height: 200, tabOrder: 0 },
    bindings: {
      Category: [C('Product', 'Category')],
      X: [M('Sales', 'Total Sales')],
      Y: [M('Sales', 'Total Orders')],
      Size: [M('Sales', 'Total Quantity')],
    },
  });
  assert.deepEqual(Object.keys(visual.visual.query.queryState).sort(), ['Category', 'Size', 'X', 'Y']);
});

test('a comparison chart gets no series unless one is asked for', async () => {
  // Regression, worked around by hand three times before being fixed: the rule filled Series from
  // the second category whenever one existed, which put 38 countries into one clustered column
  // chart. Nothing here can see cardinality, so the caller has to opt in.
  const root = await tempDir('series');
  await writeModel(root);
  const created = await createReport({ name: 'Series', outputPath: root, modelPath: '../Sales.SemanticModel' });

  const assignment = {
    title: 'x',
    kpiMeasures: [M('Sales', 'Total Sales')],
    dateField: C('Date', 'Date'),
    primaryCategory: C('Product', 'Category'),
    secondaryCategory: C('Product', 'ProductName'),
  };

  const plain = await applyBlueprint(created.reportPath, created.pageFolder, 'comparison', assignment);
  const noSeries = plain.applied.find((a) => a.slot === 'groupedBars');
  assert.ok(noSeries, 'the comparison slot should still be filled');
  assert.equal(noSeries.bindings.Series, undefined, 'Series must not appear unbidden');

  const withSeries = await applyBlueprint(
    created.reportPath,
    created.pageFolder,
    'comparison',
    { ...assignment, seriesField: C('Product', 'Category') },
    true,
  );
  const seriesed = withSeries.applied.find((a) => a.slot === 'groupedBars');
  assert.equal(seriesed.bindings.Series[0].field, 'Category');
});

test('a ranked bar chart is sorted by its measure', async () => {
  const { created } = await buildDashboard('sort', FULL_ASSIGNMENT);
  const file = path.join(created.reportPath, 'definition', 'pages', created.pageFolder, 'visuals', 'breakdown', 'visual.json');
  const visual = JSON.parse(await fs.readFile(file, 'utf8'));

  assert.equal(visual.visual.query.sortDefinition.sort[0].direction, 'Descending');
  assert.equal(visual.visual.query.sortDefinition.sort[0].field.Measure.Property, 'Total Sales');
});

test('validation catches a field that is not in the model', async () => {
  const { created, modelPath } = await buildDashboard('badfield', {
    ...FULL_ASSIGNMENT,
    kpiMeasures: [M('Sales', 'Revenue Total')],
  });

  const validation = await validateReport(created.reportPath, modelPath);
  assert.ok(validation.errors > 0);
  assert.ok(validation.findings.some((f) => f.rule === 'ref-missing' && /Revenue Total/.test(f.message)));
});

test('validation flags a case mismatch as a warning, not an error', async () => {
  const { created, modelPath } = await buildDashboard('badcase', {
    ...FULL_ASSIGNMENT,
    kpiMeasures: [{ table: 'sales', field: 'Total Sales', kind: 'Measure' }],
  });

  const validation = await validateReport(created.reportPath, modelPath);
  assert.equal(validation.errors, 0);
  assert.ok(validation.findings.some((f) => f.rule === 'ref-case'));
});

test('validation catches an unbound visual', async () => {
  const { created, modelPath } = await buildDashboard('unbound', FULL_ASSIGNMENT);
  await writeVisual({
    reportPath: created.reportPath,
    pageFolder: created.pageFolder,
    visualFolder: 'stray',
    visualType: 'donutChart',
    position: { x: 24, y: 216, z: 500, width: 200, height: 100, tabOrder: 500 },
  });

  const validation = await validateReport(created.reportPath, modelPath);
  assert.ok(validation.findings.some((f) => f.rule === 'visual-unbound'));
});

test('validation catches a broken model binding', async () => {
  const root = await tempDir('binding');
  const created = await createReport({ name: 'Orphan', outputPath: root, modelPath: '../Missing.SemanticModel' });
  const validation = await validateReport(created.reportPath);
  assert.ok(validation.findings.some((f) => f.rule === 'binding-broken'));
});

test('add_visual refuses to clobber an existing visual unless told to', async () => {
  const { created } = await buildDashboard('clobber', FULL_ASSIGNMENT);
  const args = {
    reportPath: created.reportPath,
    pageFolder: created.pageFolder,
    visualFolder: 'breakdown',
    visualType: 'barChart',
    position: getSlot('executive-overview', 'breakdown').position,
    bindings: { Category: [C('Product', 'Category')], Y: [M('Sales', 'Total Sales')] },
  };
  await assert.rejects(() => writeVisual(args), /already exists/);
  await writeVisual({ ...args, overwrite: true });
});

// ---------------------------------------------------------------------------------------------

test('preview renders every visual with its bindings', async () => {
  const { created } = await buildDashboard('preview', FULL_ASSIGNMENT);
  const preview = await renderPreview(created.reportPath);

  assert.equal(preview.pages, 1);
  assert.equal(preview.issues, 0);
  assert.match(preview.html, /Category: Product\[Category\]/);
  assert.match(preview.html, /Y: Sales\[Total Sales\]/);
  assert.match(preview.html, /Sales Overview/);
});

test('preview flags an unbound visual in red', async () => {
  const { created } = await buildDashboard('previewbad', FULL_ASSIGNMENT);
  await writeVisual({
    reportPath: created.reportPath,
    pageFolder: created.pageFolder,
    visualFolder: 'stray',
    visualType: 'donutChart',
    position: { x: 24, y: 700, z: 500, width: 200, height: 100, tabOrder: 500 },
  });

  const preview = await renderPreview(created.reportPath);
  assert.ok(preview.issues >= 2, 'expected both an unbound and an out-of-bounds issue');
  assert.match(preview.html, /no field bindings/);
  assert.match(preview.html, /extends past the canvas/);
  assert.match(preview.html, /stroke="#A4262C"/);
});

test('preview escapes text so a quote cannot break the SVG', async () => {
  const root = await tempDir('escape');
  await writeModel(root);
  const created = await createReport({ name: 'Escaped', outputPath: root, modelPath: '../Sales.SemanticModel' });
  await writeVisual({
    reportPath: created.reportPath,
    pageFolder: created.pageFolder,
    visualFolder: 'title',
    visualType: 'textbox',
    position: { x: 24, y: 16, z: 9000, width: 608, height: 56, tabOrder: 6000 },
    text: 'A & B <script> "quoted"',
  });

  const preview = await renderPreview(created.reportPath);
  assert.match(preview.html, /A &amp; B &lt;script&gt;/);
  assert.doesNotMatch(preview.html, /<script>/);
});
