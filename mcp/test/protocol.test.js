/**
 * End-to-end MCP test: spawns the real server over stdio and drives it with a real MCP client, so
 * the tool schemas, handlers and transport are all exercised the way a host would exercise them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'dist', 'index.js');

async function withClient(fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
  const client = new Client({ name: 'powerbi-dashboard-tests', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function textOf(result) {
  return (result.content ?? []).map((c) => c.text ?? '').join('\n');
}

async function fixtureModel() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pbi-mcp-proto-'));
  const tables = path.join(root, 'Sales.SemanticModel', 'definition', 'tables');
  await fs.mkdir(tables, { recursive: true });
  await fs.writeFile(
    path.join(tables, 'Sales.tmdl'),
    ['table Sales', "\tmeasure 'Total Sales' = SUM(Sales[Amount])", '\tcolumn Amount', '\t\tdataType: double', ''].join('\n'),
  );
  await fs.writeFile(
    path.join(tables, 'Date.tmdl'),
    ['table Date', '\tdataCategory: Time', '\tcolumn Date', '\t\tdataType: dateTime', ''].join('\n'),
  );
  await fs.writeFile(
    path.join(tables, 'Product.tmdl'),
    ['table Product', '\tcolumn Category', '\t\tdataType: string', ''].join('\n'),
  );
  return { root, modelPath: path.join(root, 'Sales.SemanticModel') };
}

test('server advertises every tool with a schema', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert.deepEqual(names, [
      'add_page',
      'add_visual',
      'apply_blueprint',
      'create_report',
      'describe_report',
      'harvest_layout',
      'inspect_semantic_model',
      'list_blueprints',
      'list_theme_presets',
      'list_visual_types',
      'preview_report',
      'rebind_report',
      'recommend_dashboard',
      'remove_visual',
      'set_theme',
      'validate_report',
    ]);

    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 40, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} has no object input schema`);
    }
  });
});

test('list_blueprints returns slots with concrete positions', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'list_blueprints', arguments: { name: 'executive-overview' } });
    const data = JSON.parse(textOf(result));

    assert.equal(data.blueprints.length, 1);
    const kpi = data.blueprints[0].slots.find((s) => s.slot === 'kpiRow');
    assert.deepEqual(kpi.position, { x: 24, y: 88, z: 5000, width: 1232, height: 112, tabOrder: 5000 });
  });
});

test('an unknown blueprint is reported as an error, not a crash', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'list_blueprints', arguments: { name: 'nope' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unknown blueprint/);
  });
});

test('full flow: inspect, create, apply, preview, validate', async () => {
  const { root, modelPath } = await fixtureModel();

  await withClient(async (client) => {
    const inspected = JSON.parse(
      textOf(await client.callTool({ name: 'inspect_semantic_model', arguments: { modelPath } })),
    );
    assert.equal(inspected.dateTable, 'Date');
    assert.equal(inspected.dateColumn, 'Date');
    assert.ok(inspected.kpiCandidates.some((k) => k.measure === 'Total Sales'));

    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'E2E', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );
    assert.ok(created.reportPath.endsWith('E2E.Report'));

    const applied = await client.callTool({
      name: 'apply_blueprint',
      arguments: {
        reportPath: created.reportPath,
        blueprint: 'executive-overview',
        title: 'End to end',
        kpiMeasures: [{ table: 'Sales', field: 'Total Sales', kind: 'Measure' }],
        dateField: { table: 'Date', field: 'Date', kind: 'Column' },
        primaryCategory: { table: 'Product', field: 'Category', kind: 'Column' },
      },
    });
    const appliedText = textOf(applied);
    assert.match(appliedText, /Applied 'executive-overview'/);
    assert.match(appliedText, /trend \(lineChart\)/);
    assert.match(appliedText, /Category: Product\[Category\]/);
    // Nothing was supplied for these, so they must be skipped rather than emitted empty.
    assert.match(appliedText, /composition — no secondaryCategory supplied/);

    const preview = textOf(
      await client.callTool({ name: 'preview_report', arguments: { reportPath: created.reportPath } }),
    );
    assert.match(preview, /0 issue\(s\)/);
    assert.match(preview, /Wireframe written to/);

    const validated = await client.callTool({
      name: 'validate_report',
      arguments: { reportPath: created.reportPath, modelPath },
    });
    assert.notEqual(validated.isError, true, textOf(validated));
    assert.match(textOf(validated), /No issues found/);
  });
});

test('validate_report reports an error result when a field is missing', async () => {
  const { root, modelPath } = await fixtureModel();

  await withClient(async (client) => {
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'Broken', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );

    await client.callTool({
      name: 'add_visual',
      arguments: {
        reportPath: created.reportPath,
        visualFolder: 'breakdown',
        visualType: 'barChart',
        slot: { blueprint: 'executive-overview', slot: 'breakdown' },
        bindings: {
          Category: [{ table: 'Product', field: 'Category', kind: 'Column' }],
          Y: [{ table: 'Sales', field: 'Nonexistent', kind: 'Measure' }],
        },
      },
    });

    const validated = await client.callTool({
      name: 'validate_report',
      arguments: { reportPath: created.reportPath, modelPath },
    });
    assert.equal(validated.isError, true);
    assert.match(textOf(validated), /ref-missing/);
    assert.match(textOf(validated), /Nonexistent/);
  });
});

test('add_visual rejects a role the visual type does not accept', async () => {
  const { root } = await fixtureModel();

  await withClient(async (client) => {
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'Roles', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );

    const result = await client.callTool({
      name: 'add_visual',
      arguments: {
        reportPath: created.reportPath,
        visualFolder: 'wrong',
        visualType: 'donutChart',
        position: { x: 24, y: 216, width: 400, height: 232 },
        bindings: { Rows: [{ table: 'Product', field: 'Category', kind: 'Column' }] },
      },
    });

    assert.equal(result.isError, true);
    assert.match(textOf(result), /does not accept role 'Rows'/);
  });
});

test('describe_report reads back what was written', async () => {
  const { root } = await fixtureModel();

  await withClient(async (client) => {
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'Describe', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );

    await client.callTool({
      name: 'apply_blueprint',
      arguments: {
        reportPath: created.reportPath,
        blueprint: 'detail-table',
        title: 'Rows',
        kpiMeasures: [{ table: 'Sales', field: 'Total Sales', kind: 'Measure' }],
        primaryCategory: { table: 'Product', field: 'Category', kind: 'Column' },
        detailFields: [
          { table: 'Product', field: 'Category', kind: 'Column' },
          { table: 'Sales', field: 'Total Sales', kind: 'Measure' },
        ],
      },
    });

    const described = JSON.parse(
      textOf(await client.callTool({ name: 'describe_report', arguments: { reportPath: created.reportPath } })),
    );

    assert.equal(described.binding.kind, 'byPath');
    assert.equal(described.pages.length, 1);
    const table = described.pages[0].visuals.find((v) => v.folder === 'table');
    assert.equal(table.visualType, 'tableEx');
    assert.equal(table.bindings.Values.length, 2);
  });
});

test('set_theme writes a theme the report can actually use', async () => {
  const { root } = await fixtureModel();

  await withClient(async (client) => {
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'Themed', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );

    const result = await client.callTool({
      name: 'set_theme',
      arguments: { reportPath: created.reportPath, preset: 'dark', accent: '#FF6B35', cornerRadius: 0, shadow: false },
    });
    assert.notEqual(result.isError, true, textOf(result));

    const themeFile = path.join(created.reportPath, 'StaticResources', 'RegisteredResources', 'theme.json');
    const theme = JSON.parse(await fs.readFile(themeFile, 'utf8'));

    // The accent leads the palette rather than being appended to it.
    assert.equal(theme.dataColors[0], '#FF6B35');
    assert.equal(theme.dataColors.length, 8);
    // A dark preset has to move the page off white or the whole point is lost.
    assert.notEqual(theme.visualStyles.page['*'].background[0].color.solid.color, '#FFFFFF');
    assert.equal(theme.visualStyles['*']['*'].border[0].radius, 0);
    assert.equal(theme.visualStyles['*']['*'].dropShadow[0].show, false);
  });
});

test('every theme preset and blueprint is reachable through the tools', async () => {
  // Regression, hit twice for real: the tool schemas hardcoded 3 presets and 4 blueprints while the
  // code defined 7 of each, so the rest were unreachable through MCP with no hint until a caller
  // happened to name one. Both enums are now derived, and this pins them together.
  await withClient(async (client) => {
    const { tools } = await client.listTools();

    const listedPresets = JSON.parse(
      textOf(await client.callTool({ name: 'list_theme_presets', arguments: {} })),
    ).presets;
    const acceptedPresets = tools.find((x) => x.name === 'set_theme').inputSchema.properties.preset.enum;
    assert.deepEqual([...acceptedPresets].sort(), [...listedPresets].sort());
    assert.ok(listedPresets.length >= 7, `expected at least 7 presets, got ${listedPresets.length}`);

    const listedBlueprints = JSON.parse(
      textOf(await client.callTool({ name: 'list_blueprints', arguments: {} })),
    ).blueprints.map((b) => b.name);
    assert.ok(listedBlueprints.length >= 7, `expected at least 7 blueprints, got ${listedBlueprints.length}`);

    // Blueprints must NOT be a frozen enum: harvest_layout registers new ones mid-session, and a
    // schema fixed at registration time would reject exactly the layout the caller just harvested.
    const blueprintSchema = tools.find((x) => x.name === 'apply_blueprint').inputSchema.properties.blueprint;
    assert.equal(blueprintSchema.enum, undefined, 'apply_blueprint must accept runtime-registered layouts');

    // Validation still has to happen, with an error that says what is available.
    const bad = await client.callTool({
      name: 'apply_blueprint',
      arguments: { reportPath: 'nowhere', blueprint: 'no-such-layout', title: 'x', kpiMeasures: [] },
    });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /Unknown blueprint/);
  });
});

test('each new blueprint produces a page that validates', async () => {
  const { root, modelPath } = await fixtureModel();

  await withClient(async (client) => {
    for (const blueprint of ['hero-metric', 'sidebar-detail', 'three-column']) {
      const created = JSON.parse(
        textOf(
          await client.callTool({
            name: 'create_report',
            arguments: { name: `BP ${blueprint}`, outputPath: root, modelPath: '../Sales.SemanticModel' },
          }),
        ),
      );
      const applied = await client.callTool({
        name: 'apply_blueprint',
        arguments: {
          reportPath: created.reportPath,
          blueprint,
          title: blueprint,
          kpiMeasures: [{ table: 'Sales', field: 'Total Sales', kind: 'Measure' }],
          dateField: { table: 'Date', field: 'Date', kind: 'Column' },
          primaryCategory: { table: 'Product', field: 'Category', kind: 'Column' },
        },
      });
      assert.notEqual(applied.isError, true, textOf(applied));

      const validated = await client.callTool({
        name: 'validate_report',
        arguments: { reportPath: created.reportPath, modelPath },
      });
      assert.notEqual(validated.isError, true, `${blueprint}: ${textOf(validated)}`);
    }
  });
});

test('set_theme rejects a colour that is not hex', async () => {
  const { root } = await fixtureModel();

  await withClient(async (client) => {
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'BadTheme', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );
    const result = await client.callTool({
      name: 'set_theme',
      arguments: { reportPath: created.reportPath, accent: 'red' },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /hex/);
  });
});

test('recommend_dashboard ranks layouts and returns usable arguments', async () => {
  const { root, modelPath } = await fixtureModel();

  await withClient(async (client) => {
    const result = JSON.parse(
      textOf(await client.callTool({ name: 'recommend_dashboard', arguments: { modelPath, title: 'Fixture' } })),
    );

    assert.equal(result.inventory.dateTable, 'Date');
    assert.ok(result.recommendations.length >= 1);

    // Ranking must favour completeness: the top pick cannot have more gaps than the one below it.
    for (let i = 1; i < result.recommendations.length; i++) {
      assert.ok(result.recommendations[i - 1].score >= result.recommendations[i].score, 'not sorted by score');
    }

    // The returned arguments have to actually work.
    const top = result.recommendations[0];
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'Recommended', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );
    const applied = await client.callTool({
      name: 'apply_blueprint',
      arguments: { reportPath: created.reportPath, ...top.applyArguments },
    });
    assert.notEqual(applied.isError, true, textOf(applied));

    const validated = await client.callTool({
      name: 'validate_report',
      arguments: { reportPath: created.reportPath, modelPath },
    });
    assert.notEqual(validated.isError, true, textOf(validated));
  });
});

test('harvest_layout turns a generated report back into a usable blueprint', async () => {
  const { root, modelPath } = await fixtureModel();

  await withClient(async (client) => {
    const source = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'Source', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );
    await client.callTool({
      name: 'apply_blueprint',
      arguments: {
        reportPath: source.reportPath,
        blueprint: 'executive-overview',
        title: 'Source',
        kpiMeasures: [{ table: 'Sales', field: 'Total Sales', kind: 'Measure' }],
        dateField: { table: 'Date', field: 'Date', kind: 'Column' },
        primaryCategory: { table: 'Product', field: 'Category', kind: 'Column' },
      },
    });

    const harvested = JSON.parse(
      textOf(await client.callTool({ name: 'harvest_layout', arguments: { reportPath: source.reportPath } })),
    ).harvested;

    assert.equal(harvested.length, 1);
    const page = harvested[0];
    assert.ok(page.slots.length >= 4, `expected several slots, got ${page.slots.length}`);

    // A round trip through our own generator should need no snapping at all.
    assert.equal(page.maxDriftPx, 0, 'a generated report is already on the grid');

    // Roles have to come back recognisable, or the harvest is useless.
    const roles = page.slots.map((s) => s.role);
    assert.ok(roles.includes('title'), 'title not inferred');
    assert.ok(roles.includes('kpiRow'), 'KPI row not inferred');
    assert.ok(roles.includes('trend'), 'trend not inferred');
    assert.ok(roles.includes('dateSlicer'), 'date slicer not inferred');

    // And the harvested blueprint must be applicable to a fresh report.
    const target = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'Target', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );
    const applied = await client.callTool({
      name: 'apply_blueprint',
      arguments: {
        reportPath: target.reportPath,
        blueprint: page.blueprint,
        title: 'From a harvested layout',
        kpiMeasures: [{ table: 'Sales', field: 'Total Sales', kind: 'Measure' }],
        dateField: { table: 'Date', field: 'Date', kind: 'Column' },
        primaryCategory: { table: 'Product', field: 'Category', kind: 'Column' },
      },
    });
    assert.notEqual(applied.isError, true, textOf(applied));
  });
});

test('rebind_report switches to a workspace connection', async () => {
  const { root } = await fixtureModel();

  await withClient(async (client) => {
    const created = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_report',
          arguments: { name: 'Rebind', outputPath: root, modelPath: '../Sales.SemanticModel' },
        }),
      ),
    );

    await client.callTool({
      name: 'rebind_report',
      arguments: { reportPath: created.reportPath, semanticModelId: '3f2b9c10-1a4d-4c8e-9f01-2b3c4d5e6f70' },
    });

    const described = JSON.parse(
      textOf(await client.callTool({ name: 'describe_report', arguments: { reportPath: created.reportPath } })),
    );
    assert.equal(described.binding.kind, 'byConnection');
    assert.match(described.binding.value, /semanticmodelid=3f2b9c10/);
  });
});
