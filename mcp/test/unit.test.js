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
import { gridWidth, gridX, BLUEPRINTS, getSlot } from '../dist/blueprints.js';
import { readSemanticModel, classify, resolveField } from '../dist/tmdl.js';
import { applyBlueprint } from '../dist/generate.js';
import { validateReport } from '../dist/validate.js';
import { renderPreview } from '../dist/preview.js';
import { buildTheme, buildPageObjects, resolvePalette, THEME_PRESETS } from '../dist/theme.js';
import { writeTheme } from '../dist/pbir.js';

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
    ['table Product', '\tcolumn Category', '\t\tdataType: string', '\tcolumn ProductKey', '\t\tdataType: int64', ''].join('\n'),
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
