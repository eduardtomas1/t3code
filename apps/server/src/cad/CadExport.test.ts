// @effect-diagnostics nodeBuiltinImport:off -- Drives cad_export against a fake AutoCAD console that reads its scripts and writes its outputs on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  decodeConsole,
  DWG_NEXT,
  dwgScript,
  dxfScript,
  formatNumber,
  matchPaper,
  parseAcadLocations,
  parseProbe,
  planPlot,
  plotScript,
  probeScript,
  TEMPLATE_NOTE,
  templateScript,
  type CadExportInput,
  type PlotPlan,
} from "./CadExport.ts";
import { CadError, isCadError, type CadDocument, type CadHost } from "./CadHosts.ts";
import * as CadService from "./CadService.ts";

/** A probe transcript from a Spanish AutoCAD 2025, trimmed to the lines T3 reads and their neighbours. */
const ES_PROBE = [
  'Comando: (defun t3p (s) (princ (strcat "\\nT3|" s "\\n")) (princ))',
  "T3|V|1",
  "T3|E|2249.873076|1642.852011|2462.024371|1755.458641",
  "T3|L|0|210|297|0||77,111,100,101,108,",
  "T3|L|1|210|297|1||80,114,101,115,101,110,116,97,99,105,243,110,49,",
  "T3|L|2|0|0|0|109,111,110,111,99,104,114,111,109,101,46,99,116,98,|80,114,101,115,101,110,116,97,99,105,243,110,50,",
  "T3|X|46,46,92,105,109,103,92,102,111,116,111,46,106,112,103,",
  "T3|X|67,58,92,120,114,101,102,92,115,105,116,101,46,100,119,103,",
  "Comando: _.-PLOT",
  "Introduzca un nombre de dispositivo de salida o [?] <Ninguno>: DWG To PDF.pc3",
  "Indique tamaño de papel o [?] <ANSI A (11.00 x 8.50 pulgadas)>: ?",
  "",
  "Tamaños de papel disponibles.",
  '  "ANSI A (11.00 x 8.50 pulgadas)"',
  '  "ANSI expand A (8.50 x 11.00 pulgadas)"',
  '  "ISO A0 (841.00 x 1189.00 mm)"',
  '  "ISO A2 (420.00 x 594.00 mm)"',
  '  "ISO A2 (594.00 x 420.00 mm)"',
  '  "ISO A3 (297.00 x 420.00 mm)"',
  '  "ISO A3 (420.00 x 297.00 mm)"',
  '  "ISO A4 (210.00 x 297.00 mm)"',
  '  "ISO expand A2 (594.00 x 420.00 mm)"',
  '  "ISO full bleed A0 (841.00 x 1189.00 mm)"',
  '  "ISO full bleed A1 (594.00 x 841.00 mm)"',
  '  "ISO full bleed A1 (841.00 x 594.00 mm)"',
  '  "ISO full bleed A2 (420.00 x 594.00 mm)"',
  '  "ISO full bleed A2 (594.00 x 420.00 mm)"',
  '  "ISO full bleed A3 (297.00 x 420.00 mm)"',
  '  "ISO full bleed A3 (420.00 x 297.00 mm)"',
  '  "ISO full bleed A4 (210.00 x 297.00 mm)"',
  '  "ISO full bleed A4 (297.00 x 210.00 mm)"',
  "",
  "Indique nombre de tabla de estilo de trazado o [?] (indique . para ninguna) <>: ?",
  "Tablas de estilos de trazado disponibles.",
  '  "acad.stb"',
  '  "monochrome.stb"',
  '  "acad.ctb"',
  '  "Grayscale.ctb"',
  '  "monochrome.ctb"',
  '  "Screening 25%.ctb"',
  "",
].join("\r\n");

/** The same listings as an English install prints them. */
const EN_PROBE = [
  "T3|V|1",
  "T3|E|0|0|40|30",
  "T3|L|0|0|0|0||77,111,100,101,108,",
  "Available paper sizes.",
  '  "ISO A2 (594.00 x 420.00 MM)"',
  '  "ISO full bleed A2 (420.00 x 594.00 MM)"',
  '  "ISO full bleed A3 (420.00 x 297.00 MM)"',
  '  "ARCH full bleed D (36.00 x 24.00 Inches)"',
  "Available plot style tables.",
  '  "monochrome.ctb"',
].join("\n");

const plan = (overrides: Partial<PlotPlan> = {}): PlotPlan => ({
  device: "png",
  layout: "model",
  paper: "",
  landscape: true,
  area: "extents",
  mmPerUnit: undefined,
  plotStyle: "monochrome.ctb",
  ...overrides,
});

const lines = (script: string) => script.split("\r\n");

describe("cad_export scripts", () => {
  it("are printable ASCII lines that end by quitting", () => {
    for (const script of [
      probeScript(),
      plotScript(plan()),
      plotScript(
        plan({
          device: "pdf",
          layout: 2,
          area: "layout",
          paper: "ISO full bleed A2 (594.00 x 420.00 mm)",
        }),
      ),
      dxfScript(),
      dwgScript(false),
      dwgScript(true),
      templateScript(),
    ]) {
      expect(script.endsWith("_.QUIT\r\n_Y\r\n")).toBe(true);
      for (const line of lines(script)) expect(line).toMatch(/^[\x20-\x7E]*$/u);
    }
  });

  it.each([
    [
      "png of model extents, with the device's default paper",
      plan(),
      [
        "PublishToWeb PNG.pc3",
        "",
        "_L",
        "_N",
        "_E",
        "_F",
        "_C",
        "_Y",
        "monochrome.ctb",
        "_Y",
        "_A",
        "out.png",
      ],
    ],
    [
      "pdf of a window at 1:50 in metres",
      plan({
        device: "pdf",
        paper: "ISO full bleed A2 (594.00 x 420.00 mm)",
        area: { min: [2432, 1667.5], max: [2458.25, 1698] },
        mmPerUnit: 20,
        landscape: false,
      }),
      [
        "DWG To PDF.pc3",
        "ISO full bleed A2 (594.00 x 420.00 mm)",
        "_M",
        "_P",
        "_N",
        "_W",
        "2432,1667.5",
        "2458.25,1698",
        "20=1",
        "_C",
      ],
    ],
    [
      "a layout by index, whose offset prompt has no Center option",
      plan({ layout: 1, area: "layout", plotStyle: "" }),
      [
        '(setvar "CTAB" (t3lay 1))',
        '(setvar "PLOTTRANSPARENCYOVERRIDE" 2)',
        "_.-PLOT",
        "_Y",
        "",
        "PublishToWeb PNG.pc3",
        "",
        "_L",
        "_N",
        "_L",
        "_F",
        "",
        "_Y",
        "",
        "_Y",
        "_N",
        "_N",
        "_N",
        "out.png",
      ],
    ],
  ])("plots %s", (_name, input, expected) => {
    const script = lines(plotScript(input));
    const start = script.indexOf(expected[0] ?? "");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(script.slice(start, start + expected.length)).toEqual(expected);
    // Translucent fills plot solid black unless transparency is forced on.
    expect(script[script.indexOf("_.-PLOT") - 1]).toBe(
      String.raw`(setvar "PLOTTRANSPARENCYOVERRIDE" 2)`,
    );
  });

  it("dxf, dwg and template scripts write fixed names beside the copy", () => {
    expect(lines(dxfScript())).toContain("out.dxf");
    expect(lines(dwgScript(false))).toEqual(expect.arrayContaining(["_.AUDIT", "out.dwg"]));
    expect(lines(dwgScript(false))).not.toContain("_.INSUNITS");
    expect(lines(dwgScript(true))).toEqual(
      expect.arrayContaining(["_.INSUNITS", "0", "t3new.dwg"]),
    );
    const template = lines(templateScript());
    const insert = template.indexOf("_.-INSERT");
    // Model space first, even when the template was saved on a layout tab.
    expect(template.slice(insert - 2, insert + 5)).toEqual([
      "_.TILEMODE",
      "1",
      "_.-INSERT",
      "*t3new.dwg",
      "0,0",
      "1",
      "0",
    ]);
    expect(template).toEqual(expect.arrayContaining(['(setvar "INSUNITS" t3u)', "out.dwg"]));
  });

  it.each([
    ["a newline in a paper name", plan({ paper: "A2\n_.ERASE" })],
    ["a paper name that would run LISP", plan({ paper: '(command "_.ERASE")' })],
    ["a quote in a plot style", plan({ plotStyle: 'x".ctb' })],
    ["a transparent command", plan({ plotStyle: "'_.ERASE" })],
    ["a non-integer layout index", plan({ layout: 1.5 })],
    ["a coordinate past 1e15", plan({ area: { min: [0, 0], max: [1e16, 1] } })],
  ])("refuses %s", (_name, input) => {
    expect(() => plotScript(input)).toThrow();
  });

  it("formats numbers without exponents", () => {
    expect(formatNumber(20)).toBe("20");
    expect(formatNumber(-0.0000001)).toBe("0");
    expect(formatNumber(1e-5)).toBe("0.00001");
    expect(formatNumber(2432.067375170532)).toBe("2432.067375");
    expect(() => formatNumber(Number.NaN)).toThrow();
  });
});

describe("cad_export probe", () => {
  it("reads layouts, extents, references and listings from a Spanish install", () => {
    const probe = parseProbe(ES_PROBE);
    expect(probe.namedPlotStyles).toBe(false);
    expect(probe.extents).toEqual({
      min: [2249.873076, 1642.852011],
      max: [2462.024371, 1755.458641],
    });
    expect(probe.layouts.map((layout) => [layout.index, layout.name, layout.plotStyle])).toEqual([
      [0, "Model", ""],
      [1, "Presentación1", ""],
      [2, "Presentación2", "monochrome.ctb"],
    ]);
    expect(probe.references).toEqual(["..\\img\\foto.jpg", "C:\\xref\\site.dwg"]);
    expect(probe.plotStyles).toContain("Screening 25%.ctb");
    expect(probe.papers).toContain("ISO full bleed A2 (594.00 x 420.00 mm)");
    expect(probe.papers).not.toContain("monochrome.ctb");
  });

  it("decodes the console's UTF-16 and its 8-bit lines alike", () => {
    const bytes = Buffer.concat([
      Buffer.from("T3|V|1\r\n", "utf16le"),
      Buffer.from("plot stamp log\r\n", "latin1"),
      Buffer.from('  "monochrome.ctb"\r\n', "utf16le"),
    ]);
    const probe = parseProbe(decodeConsole(bytes));
    expect(probe.plotStyles).toEqual(["monochrome.ctb"]);
  });

  it.each([
    ["A2 landscape (es)", ES_PROBE, "A2", true, "ISO full bleed A2 (594.00 x 420.00 mm)"],
    ["A2 portrait (es)", ES_PROBE, "A2", false, "ISO full bleed A2 (420.00 x 594.00 mm)"],
    [
      "A0, listed only portrait (es)",
      ES_PROBE,
      "A0",
      true,
      "ISO full bleed A0 (841.00 x 1189.00 mm)",
    ],
    [
      "A2 landscape (en, upper-case MM)",
      EN_PROBE,
      "A2",
      true,
      "ISO full bleed A2 (420.00 x 594.00 MM)",
    ],
    ["A3 (en)", EN_PROBE, "A3", false, "ISO full bleed A3 (420.00 x 297.00 MM)"],
    ["A4, not listed (en)", EN_PROBE, "A4", true, undefined],
  ] as const)("matches paper on dimensions: %s", (_name, output, size, landscape, expected) => {
    expect(matchPaper(parseProbe(output).papers, size, landscape)).toBe(expected);
  });

  it("finds AutoCAD folders in reg.exe output, newest first", () => {
    const output = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R24.3\\ACAD-7101:409",
      "    AcadLocation    REG_SZ    C:\\Program Files\\Autodesk\\AutoCAD 2024",
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.0\\ACAD-8101:40A",
      "    AcadLocation    REG_SZ    C:\\Program Files\\Autodesk\\AutoCAD 2025\\",
      "",
      "Fin de la búsqueda: 2 coincidencias encontradas.",
    ].join("\r\n");
    expect(parseAcadLocations(output)).toEqual([
      "C:\\Program Files\\Autodesk\\AutoCAD 2025\\",
      "C:\\Program Files\\Autodesk\\AutoCAD 2024",
    ]);
  });
});

describe("cad_export plans", () => {
  const probe = parseProbe(ES_PROBE);
  const planned = (input: Partial<CadExportInput> & { readonly format: "png" | "pdf" }) => {
    const result = planPlot({ source: "C:\\a.dwg", ...input }, probe);
    if (isCadError(result)) throw new Error(result.message);
    return result;
  };
  const refusal = (input: Partial<CadExportInput> & { readonly format: "png" | "pdf" }) => {
    const result = planPlot({ source: "C:\\a.dwg", ...input }, probe);
    return isCadError(result) ? result.message : undefined;
  };

  it("defaults to model extents in monochrome, and warns about relative references", () => {
    const result = planned({ format: "png" });
    expect(result.plan).toMatchObject({
      layout: "model",
      area: "extents",
      plotStyle: "monochrome.ctb",
      landscape: true,
    });
    expect(result.warnings).toEqual([expect.stringContaining("..\\img\\foto.jpg")]);
    expect(result.warnings[0]).not.toContain("site.dwg");
  });

  it("picks layouts by index and keeps their own plot style", () => {
    expect(planned({ format: "png", layout: "presentación2" }).plan).toMatchObject({
      layout: 2,
      area: "layout",
      plotStyle: "monochrome.ctb",
    });
  });

  it("chooses the smallest sheet the scaled area fits, oriented by its shape", () => {
    const result = planned({ format: "pdf", area: { min: [0, 0], max: [26, 16] }, mmPerUnit: 20 });
    expect(result.paperSize).toBe("A2");
    expect(result.plan).toMatchObject({
      paper: "ISO full bleed A2 (594.00 x 420.00 mm)",
      landscape: true,
      mmPerUnit: 20,
    });
    const portrait = planned({
      format: "pdf",
      area: { min: [0, 0], max: [12, 16] },
      mmPerUnit: 20,
    });
    expect(portrait.paperSize).toBe("A3");
    expect(portrait.plan.landscape).toBe(false);
  });

  it("keeps PNGs landscape, since their pixel size is fixed", () => {
    expect(planned({ format: "png", area: { min: [0, 0], max: [10, 30] } }).plan.landscape).toBe(
      true,
    );
  });

  it.each([
    ["an unknown layout", { format: "png", layout: "Sheet\n_.ERASE" }, "No layout named"],
    [
      "a plot style that is not installed",
      { format: "png", plotStyle: "monochrome.ctb\n_.ERASE" },
      "plotStyle must be one of",
    ],
    [
      "a named style in a colour-dependent drawing",
      { format: "png", plotStyle: "monochrome.stb" },
      "plotStyle must be one of",
    ],
    [
      "an area that does not fit the paper",
      { format: "pdf", area: { min: [0, 0], max: [30, 20] }, mmPerUnit: 20, paper: "A3" },
      "larger than A3",
    ],
    ["an empty area", { format: "png", area: { min: [5, 5], max: [5, 9] } }, "area.min"],
  ] as const)("refuses %s", (_name, input, message) => {
    expect(refusal(input)).toContain(message);
  });
});

type Console = {
  readonly script: string;
  readonly workDir: string;
  readonly args: ReadonlyArray<string>;
  readonly stdout: (text: string) => void;
};

const PNG_HEADER = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000006400000050008020000000000000000",
  "hex",
);

/** What AutoCAD's console writes for each script T3 generates. */
// Every output differs, so a replaced file is visibly a new one.
let outputs = 0;
const realistic = ({ script, workDir, stdout }: Console) => {
  outputs += 1;
  const write = (name: string, contents: string | Buffer) =>
    NodeFS.writeFileSync(NodePath.join(workDir, name), contents);
  if (script.includes("probe.pdf")) stdout(ES_PROBE);
  else if (script.includes("out.png")) write("out.png", PNG_HEADER);
  else if (script.includes("out.pdf")) write("out.pdf", "%PDF-1.7");
  else if (script.includes("out.dxf")) write("out.dxf", `0\nEOF ${outputs}`);
  else if (script.includes("_.-INSERT")) write("out.dwg", `AC1032 ${outputs}`);
  else if (script.includes("t3new.dwg")) write("t3new.dwg", "AC1032 temp");
  else if (script.includes("out.dwg")) write("out.dwg", `AC1032 ${outputs}`);
};

const ok = (): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const fakeConsole = (
  acadDir: string | undefined,
  behave: (run: Console) => Effect.Effect<void, ProcessRunner.ProcessRunError> | void = realistic,
) => {
  const runs: Array<Console> = [];
  const runner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) =>
      Effect.suspend(() => {
        if (input.command.endsWith("reg.exe")) {
          return Effect.succeed({
            ...ok(),
            stdout:
              acadDir === undefined
                ? ""
                : `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.0\\ACAD-8101:409\r\n    AcadLocation    REG_SZ    ${acadDir}\r\n`,
          });
        }
        const script = NodeFS.readFileSync(input.args[3] ?? "", "latin1");
        const run: Console = {
          script,
          workDir: input.cwd ?? "",
          args: input.args,
          stdout: (text) => input.onStdoutChunk?.(Buffer.from(text, "utf16le")),
        };
        runs.push(run);
        const outcome = behave(run);
        return (outcome ?? Effect.void).pipe(Effect.as(ok()));
      }),
  };
  return { runner, runs };
};

const autoCad = (documents: ReadonlyArray<CadDocument>): CadHost => ({
  app: "autocad",
  owns: (id) => id.startsWith("acad:"),
  status: Effect.succeed({ app: "autocad", state: "connected", documents }),
  call: () =>
    Effect.fail(
      new CadError({ code: "HOST_ERROR", message: "cad_export must not call the bridge" }),
    ),
  setup: Effect.die("unused"),
});

/** A scratch folder with an AutoCAD install, a state dir and a work folder, and the service over them. */
const setup = (options: {
  readonly installed?: boolean;
  readonly documents?: ReadonlyArray<CadDocument>;
  readonly platform?: NodeJS.Platform;
  readonly behave?: Parameters<typeof fakeConsole>[1];
}) =>
  Effect.gen(function* () {
    const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "t3-cad-export-",
    });
    const acadDir = NodePath.join(root, "AutoCAD 2025");
    NodeFS.mkdirSync(acadDir);
    if (options.installed !== false)
      NodeFS.writeFileSync(NodePath.join(acadDir, "accoreconsole.exe"), "");
    const work = NodePath.join(root, "work");
    NodeFS.mkdirSync(work);
    const fake = fakeConsole(acadDir, options.behave);
    const context = yield* Layer.build(
      CadService.layerWithHosts([autoCad(options.documents ?? [])], fake.runner).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), NodePath.join(root, "state"))),
        Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "win32")),
        // Keeps the Program Files fallback away from a real AutoCAD on the test machine.
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ProgramFiles: root } })),
        ),
      ),
    );
    const exportsDir = NodePath.join(root, "state", "userdata", "cad", "exports");
    return {
      root,
      cad: Context.get(context, CadService.CadService),
      runs: fake.runs,
      work,
      leftovers: () => (NodeFS.existsSync(exportsDir) ? NodeFS.readdirSync(exportsDir) : []),
      file: (name: string, contents: string) => {
        const path = NodePath.join(work, name);
        NodeFS.writeFileSync(path, contents);
        return path;
      },
    };
  });

const failureOf = <A>(effect: Effect.Effect<A, CadError>) =>
  effect.pipe(Effect.andThen(Effect.die("expected cad_export to fail")), Effect.flip);

it.layer(NodeServices.layer)("CadService.export", (it) => {
  it.effect(
    "works on a copy: the original path never reaches the console and the file is untouched",
    () =>
      Effect.gen(function* () {
        const { cad, runs, file, leftovers } = yield* setup({});
        const source = file("Plan nau.dwg", "AC1032 the designer's drawing");
        const before = NodeFS.statSync(source);
        const result = yield* cad.export({ source, format: "png" });
        expect(result.screenshot).toMatchObject({ width: 1600, height: 1280 });
        expect(result.path).toBeUndefined();
        expect(result.areaPlotted).toEqual({
          min: [2249.873076, 1642.852011],
          max: [2462.024371, 1755.458641],
        });
        expect(runs.map((run) => run.script.includes("probe.pdf"))).toEqual([true, false]);
        for (const run of runs) {
          expect(run.args.join(" ")).not.toContain(NodePath.dirname(source));
          expect(run.script).not.toContain("Plan nau");
          expect(run.args).toEqual(expect.arrayContaining(["/isolate", "t3code"]));
        }
        const after = NodeFS.statSync(source);
        expect(NodeFS.readFileSync(source, "utf8")).toBe("AC1032 the designer's drawing");
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(leftovers()).toEqual([]);
      }),
  );

  it.effect(
    "reports unsaved changes, and keeps exports of the designer's drawings out of their folder",
    () =>
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "t3-cad-doc-",
        });
        const path = NodePath.join(root, "Plan.dwg");
        NodeFS.writeFileSync(path, "AC1032");
        const document: CadDocument = {
          documentId: "acad:plan",
          app: "autocad",
          name: "Plan.dwg",
          path,
          modified: true,
          active: true,
        };
        const { cad, root: t3 } = yield* setup({ documents: [document] });
        const result = yield* cad.export({ source: "acad:plan", format: "pdf", paper: "A3" });
        expect(result).toMatchObject({ liveUnsaved: true, sourcePath: path, paper: "A3" });
        expect(result.path).toBe(
          NodePath.join(t3, "state", "userdata", "cad", "exported", "Plan.pdf"),
        );
        expect(NodeFS.readdirSync(root)).toEqual(["Plan.dwg"]);
        const byPath = yield* cad.export({ source: path, format: "png" });
        expect(byPath.liveUnsaved).toBe(true);
      }),
  );

  it.effect(
    "overwrites only its own earlier export; anything else gets a stamped name or a refusal",
    () =>
      Effect.gen(function* () {
        const { cad, work, file } = yield* setup({});
        const source = file("facade.dxf", "0\nEOF");
        const first = yield* cad.export({ source, format: "dwg" });
        expect(first).toMatchObject({ path: NodePath.join(work, "facade.dwg"), next: DWG_NEXT });
        const second = yield* cad.export({ source, format: "dwg" });
        expect(second.path).toBe(first.path);
        expect(NodeFS.readdirSync(work).toSorted()).toEqual(["facade.dwg", "facade.dxf"]);
        const fromOwnDwg = yield* cad.export({ source: second.path ?? "", format: "pdf" });
        expect(fromOwnDwg.path).toBe(NodePath.join(work, "facade.pdf"));

        NodeFS.writeFileSync(first.path ?? "", "the designer saved over it");
        const third = yield* cad.export({ source, format: "dwg" });
        expect(third.path).toMatch(/facade \(T3 export \d{4}-\d\d-\d\d \d{6}\)\.dwg$/u);
        expect(NodeFS.readFileSync(first.path ?? "", "utf8")).toBe("the designer saved over it");

        const foreign = file("Elsewhere.dwg", "not T3's");
        const refused = yield* failureOf(
          cad.export({ source, format: "dwg", destination: foreign }),
        );
        expect(refused.code).toBe("DESTINATION_EXISTS");
        expect(NodeFS.readFileSync(foreign, "utf8")).toBe("not T3's");

        const sameAsSource = yield* cad.export({ source, format: "dxf" });
        expect(sameAsSource.path).toMatch(/facade \(T3 export .*\)\.dxf$/u);
        expect(NodeFS.readFileSync(source, "utf8")).toBe("0\nEOF");
      }),
  );

  it.effect("stops at the timeout and leaves no partial file anywhere", () =>
    Effect.gen(function* () {
      const { cad, work, file, leftovers } = yield* setup({
        behave: (run) =>
          run.script.includes("out.pdf")
            ? Effect.sync(() =>
                NodeFS.writeFileSync(NodePath.join(run.workDir, "out.pdf"), "%PDF-partial"),
              ).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProcessRunner.ProcessTimeoutError({
                      command: "accoreconsole.exe",
                      argumentCount: 6,
                      timeoutMs: 5,
                    }),
                  ),
                ),
              )
            : realistic(run),
      });
      const source = file("Plan.dwg", "AC1032");
      const error = yield* failureOf(cad.export({ source, format: "pdf" }));
      expect(error.code).toBe("EXPORT_TIMEOUT");
      expect(NodeFS.readdirSync(work)).toEqual(["Plan.dwg"]);
      expect(leftovers()).toEqual([]);
    }),
  );

  it.effect("fails when the console writes nothing, and when it is missing", () =>
    Effect.gen(function* () {
      const silent = yield* setup({ behave: () => undefined });
      const error = yield* failureOf(
        silent.cad.export({ source: silent.file("a.dwg", "AC1032"), format: "dxf" }),
      );
      expect(error.code).toBe("EXPORT_FAILED");

      const missing = yield* setup({ installed: false });
      expect((yield* missing.cad.status("autocad")).headless).toBe(false);
      const notInstalled = yield* failureOf(
        missing.cad.export({ source: missing.file("a.dwg", "AC1032"), format: "dxf" }),
      );
      expect(notInstalled.code).toBe("NOT_INSTALLED");
    }),
  );

  it.effect("builds a dwg on a template in two passes, and refuses other sources and options", () =>
    Effect.gen(function* () {
      const { cad, runs, file } = yield* setup({});
      const source = file("new.dxf", "0\nEOF");
      const template = file("Plan.dwg", "AC1032");
      const built = yield* cad.export({
        source,
        format: "dwg",
        template,
        destination: NodePath.join(NodePath.dirname(source), "built.dwg"),
      });
      expect(built.next).toBe(DWG_NEXT);
      expect(built.warnings).toEqual([TEMPLATE_NOTE]);
      expect(runs.map((run) => run.args[1]?.split(/[\\/]/u).at(-1))).toEqual([
        "in.dxf",
        "template.dwg",
      ]);

      for (const [input, message] of [
        [{ source: template, format: "dwg" }, "dwg builds a new drawing from a .dxf"],
        [{ source, format: "dxf", template }, "template applies only to dwg"],
        [{ source, format: "png", mmPerUnit: 20 }, "mmPerUnit applies only to pdf"],
        [
          { source, format: "dxf", area: { min: [0, 0], max: [1, 1] } },
          "area applies only to png and pdf",
        ],
        [{ source: "relative\\plan.dwg", format: "png" }, "absolute path"],
        [{ source: "skp:1:model", format: "png" }, "SketchUp"],
        [{ source: "acad:missing", format: "png" }, "Unknown documentId"],
      ] as const) {
        expect((yield* failureOf(cad.export(input))).message).toContain(message);
      }
    }),
  );

  it.effect("is unsupported outside Windows", () =>
    Effect.gen(function* () {
      const { cad, file } = yield* setup({ platform: "darwin" });
      const error = yield* failureOf(
        cad.export({ source: file("a.dwg", "AC1032"), format: "png" }),
      );
      expect(error.code).toBe("UNSUPPORTED_PLATFORM");
      expect((yield* cad.status()).headless).toBe(false);
    }),
  );
});
