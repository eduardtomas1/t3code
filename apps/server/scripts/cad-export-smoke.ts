// @effect-diagnostics nodeBuiltinImport:off - a local smoke run reads and writes fixture files directly.
// @effect-diagnostics globalConsole:off globalConsoleInEffect:off globalJsonInEffect:off globalDateInEffect:off - a local transcript, timed by the wall clock.
// Runs cad_export against the real headless AutoCAD on this computer: a DXF fixture to dwg, the
// same DXF onto a template whose definitions must win, then png and pdf. Opt-in and local only;
// it skips when accoreconsole is absent and never touches a running AutoCAD.
//   vp run --filter t3 cad:smoke [outDir] [--dxf <file.dxf> --template <file.dwg>]
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CadExportResult } from "../src/cad/CadExport.ts";
import type { CadError } from "../src/cad/CadHosts.ts";
import * as CadService from "../src/cad/CadService.ts";
import * as ServerConfig from "../src/config.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const outDir = NodePath.resolve(
  args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--")) ??
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cad-smoke-")),
);
NodeFS.mkdirSync(outDir, { recursive: true });

/** A minimal R12 DXF in metres: a 12 x 8 frame, a cross, a circle and a label on `layer`. */
const dxf = (layers: ReadonlyArray<readonly [string, number]>, entities: string) =>
  [
    "0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n" + layers.length,
    ...layers.map(([name, color]) => `0\nLAYER\n2\n${name}\n70\n0\n62\n${color}\n6\nCONTINUOUS`),
    "0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES",
    entities,
    "0\nENDSEC\n0\nEOF\n",
  ].join("\n");
const line = (layer: string, x1: number, y1: number, x2: number, y2: number) =>
  `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${y1}\n30\n0\n11\n${x2}\n21\n${y2}\n31\n0`;
const drawing = [
  line("WALL", 100, 50, 112, 50),
  line("WALL", 112, 50, 112, 58),
  line("WALL", 112, 58, 100, 58),
  line("WALL", 100, 58, 100, 50),
  line("GLAZING", 100, 50, 112, 58),
  line("GLAZING", 100, 58, 112, 50),
  "0\nCIRCLE\n8\nGLAZING\n10\n106\n20\n54\n30\n0\n40\n2.5",
  "0\nTEXT\n8\nWALL\n10\n101\n20\n56.5\n30\n0\n40\n0.8\n1\nT3 SMOKE",
].join("\n");

const fixture = NodePath.join(outDir, "fixture.dxf");
// The agent's DXF defines WALL as blue (5); the template defines it red (1), and red must win.
NodeFS.writeFileSync(
  fixture,
  dxf(
    [
      ["WALL", 5],
      ["GLAZING", 3],
    ],
    drawing,
  ),
);
const templateDxf = NodePath.join(outDir, "template-source.dxf");
NodeFS.writeFileSync(
  templateDxf,
  dxf(
    [
      ["WALL", 1],
      ["OLD", 2],
    ],
    line("OLD", 0, 0, 500, 300),
  ),
);

const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

/** Counts pixels that are not white in an 8-bit RGB or RGBA PNG. */
const inkedPixels = (png: Buffer) => {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const colorType = png[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (png[24] !== 8 || channels === 0 || png[28] !== 0) return { width, height, inked: -1 };
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("latin1", offset + 4, offset + 8) === "IDAT") {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const raw = NodeZlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const previous = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  let inked = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const left = x >= channels ? (row[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      const paeth = () => {
        const p = left + up - upLeft;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        return a <= b && a <= c ? left : b <= c ? up : upLeft;
      };
      const predicted =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth()
                : 0;
      row[x] = (value + predicted) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      if (
        (row[x * channels] ?? 255) < 250 ||
        (row[x * channels + 1] ?? 255) < 250 ||
        (row[x * channels + 2] ?? 255) < 250
      ) {
        inked++;
      }
    }
    row.copy(previous);
  }
  return { width, height, inked };
};

/** The first page's MediaBox in mm. */
const pageSize = (pdf: Buffer) => {
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/u.exec(
    pdf.toString("latin1"),
  );
  if (box === null) return undefined;
  const toMm = (points: number) => (points * 25.4) / 72;
  return {
    width: toMm(Number(box[3]) - Number(box[1])),
    height: toMm(Number(box[4]) - Number(box[2])),
  };
};

/** The ACI colour of `layer` in a DXF's LAYER table. */
const layerColor = (text: string, layer: string) => {
  const pairs = text.split(/\r?\n/u).map((value) => value.trim());
  for (let i = 0; i + 3 < pairs.length; i += 2) {
    if (pairs[i] === "0" && pairs[i + 1] === "LAYER") {
      let name: string | undefined;
      let color: number | undefined;
      for (let j = i + 2; j + 1 < pairs.length && pairs[j] !== "0"; j += 2) {
        if (pairs[j] === "2") name = pairs[j + 1];
        if (pairs[j] === "62") color = Number(pairs[j + 1]);
      }
      if (name === layer) return color;
    }
  }
  return undefined;
};

const show = ({ screenshot, ...rest }: CadExportResult) =>
  JSON.stringify(screenshot === undefined ? rest : { ...rest, screenshot: "<png>" });

const timed = Effect.fn("cadExportSmoke.timed")(function* (
  label: string,
  effect: Effect.Effect<CadExportResult, CadError>,
) {
  const at = Date.now();
  const result = yield* effect;
  console.log(`${label} (${((Date.now() - at) / 1000).toFixed(1)} s): ${show(result)}`);
  return result;
});

const program = Effect.gen(function* () {
  const cad = yield* CadService.CadService;
  const status = yield* cad.status("autocad");
  console.log(`out: ${outDir}`);
  console.log(`headless: ${status.headless}`);
  if (!status.headless) {
    console.log("SKIP: headless AutoCAD (accoreconsole.exe) is not installed here.");
    return;
  }
  const started = Date.now();
  const dwg = yield* timed("dxf -> dwg", cad.export({ source: fixture, format: "dwg" }));
  check(dwg.path !== undefined && NodeFS.statSync(dwg.path).size > 0, "dwg written beside the DXF");
  const again = yield* timed("dxf -> dwg again", cad.export({ source: fixture, format: "dwg" }));
  check(
    again.path === dwg.path,
    "a second export replaces T3's own earlier file, not a stamped copy",
  );

  const template = yield* timed(
    "template dxf -> dwg",
    cad.export({ source: templateDxf, format: "dwg" }),
  );
  const built = yield* timed(
    "dxf + template -> dwg",
    cad.export({
      source: fixture,
      format: "dwg",
      template: template.path ?? "",
      destination: NodePath.join(outDir, "with-template.dwg"),
    }),
  );
  const builtDxf = yield* timed(
    "with-template.dwg -> dxf",
    cad.export({ source: built.path ?? "", format: "dxf" }),
  );
  const builtText = NodeFS.readFileSync(builtDxf.path ?? "", "latin1");
  check(
    layerColor(builtText, "WALL") === 1,
    "the template's WALL definition (red) wins over the DXF's (blue)",
  );
  check(layerColor(builtText, "GLAZING") === 3, "a layer only the DXF defines is added");
  check(
    !/\nOLD\r?\n/u.test(builtText.split("ENTITIES")[1] ?? ""),
    "the template's own geometry is gone",
  );
  check(
    built.warnings.some((warning) => warning.includes("model space")),
    "the result says only model space was kept",
  );

  const png = yield* timed(
    "dwg -> png",
    cad.export({
      source: dwg.path ?? "",
      format: "png",
      destination: NodePath.join(outDir, "fixture.png"),
    }),
  );
  const pixels = inkedPixels(NodeFS.readFileSync(png.path ?? ""));
  console.log(`png ${pixels.width}x${pixels.height}, ${pixels.inked} inked pixels`);
  check(pixels.inked > 1000, "the PNG is not blank");
  check(png.warnings.length === 0, "monochrome.ctb is listed under /isolate, so nothing fell back");
  check(png.screenshot !== undefined, "the PNG is returned inline");

  const pdf = yield* timed(
    "dwg -> pdf",
    cad.export({ source: dwg.path ?? "", format: "pdf", mmPerUnit: 20, paper: "A3" }),
  );
  const page = pageSize(NodeFS.readFileSync(pdf.path ?? ""));
  console.log(`pdf page ${page?.width.toFixed(1)} x ${page?.height.toFixed(1)} mm`);
  check(
    page !== undefined && Math.abs(page.width - 420) < 1 && Math.abs(page.height - 297) < 1,
    "the PDF page is A3 landscape",
  );

  const dxfPath = option("--dxf");
  const templatePath = option("--template");
  if (dxfPath !== undefined) {
    const real = yield* timed(
      "--dxf + --template -> dwg",
      cad.export({
        source: NodePath.resolve(dxfPath),
        format: "dwg",
        ...(templatePath === undefined ? {} : { template: NodePath.resolve(templatePath) }),
        destination: NodePath.join(outDir, "real.dwg"),
      }),
    );
    yield* timed(
      "real.dwg -> png",
      cad.export({
        source: real.path ?? "",
        format: "png",
        destination: NodePath.join(outDir, "real.png"),
      }),
    );
    yield* timed(
      "real.dwg -> pdf",
      cad.export({
        source: real.path ?? "",
        format: "pdf",
        mmPerUnit: 20,
        destination: NodePath.join(outDir, "real.pdf"),
      }),
    );
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

program.pipe(
  Effect.provide(
    CadService.layerWithHosts([]).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), NodePath.join(outDir, "state"))),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
  Effect.tapError((error) => Effect.sync(() => console.log(`FAIL ${String(error)}`))),
  NodeRuntime.runMain,
);
