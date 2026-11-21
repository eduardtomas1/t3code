// @effect-diagnostics nodeBuiltinImport:off - Copies drawings into a scratch folder, runs AutoCAD's console on them, and writes the results next to the designer's files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import { CadError, isCadError, type CadDocument } from "./CadHosts.ts";

export const ExportFormat = Schema.Literals(["png", "pdf", "dxf", "dwg"]);
export type ExportFormat = typeof ExportFormat.Type;

/** ISO sizes in mm, landscape. */
const PAPER_SIZES = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
} as const;
export const PaperSize = Schema.Literals(["A4", "A3", "A2", "A1", "A0"]);
export type PaperSize = typeof PaperSize.Type;

export interface Bounds {
  readonly min: readonly [number, number];
  readonly max: readonly [number, number];
}

export interface CadExportInput {
  readonly source: string;
  readonly format: ExportFormat;
  readonly area?: { readonly min: ReadonlyArray<number>; readonly max: ReadonlyArray<number> };
  readonly layout?: string | undefined;
  readonly mmPerUnit?: number | undefined;
  readonly paper?: PaperSize | undefined;
  readonly plotStyle?: string | undefined;
  readonly template?: string | undefined;
  readonly destination?: string | undefined;
}

export interface CadExportResult {
  readonly format: ExportFormat;
  readonly path?: string;
  readonly screenshot?: {
    readonly pngBase64: string;
    readonly width: number;
    readonly height: number;
  };
  readonly sourcePath: string;
  readonly sourceSavedAt: string;
  readonly liveUnsaved?: true;
  readonly areaPlotted?: Bounds | "layout" | null;
  readonly paper?: PaperSize;
  readonly mmPerUnit?: number;
  readonly warnings: ReadonlyArray<string>;
  readonly next?: string;
}

export const DWG_NEXT =
  "Render it (png) beside one of the designer's sheets before delivering. Match what the designer's sheets contain and omit what they omit (dimensions, callouts, legends). Choose the scale so the drawing fills most of the sheet. Use heavy lines for cut and outline, hairlines for joints and glazing.";

// A script line is console input and a newline is Enter, so every line is printable
// ASCII built here: numbers are formatted by T3, names come only from AutoCAD's own listings,
// layouts are chosen by index, and files have fixed names relative to the scratch folder.
const SCRIPT_LINE = /^[\x20-\x7E]*$/u;

/** A name AutoCAD listed that may be typed back at a prompt; `(`, `!` and `'` would run LISP or a transparent command. */
const isPromptSafe = (name: string) =>
  /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/u.test(name) &&
  !/^[(!']/u.test(name) &&
  !name.includes('"');

/** Plain decimal text, never exponent notation. */
export const formatNumber = (value: number) => {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) {
    throw new RangeError("Script numbers must be finite and below 1e15.");
  }
  const text = value.toFixed(6).replace(/\.?0+$/u, "");
  return text === "-0" ? "0" : text;
};

const script = (lines: ReadonlyArray<string>) => {
  for (const line of lines) {
    if (!SCRIPT_LINE.test(line)) throw new Error("A script line is not printable ASCII.");
  }
  return `${lines.join("\r\n")}\r\n`;
};

const START = ["_.FILEDIA", "0"];
const QUIT = ["_.QUIT", "_Y"];

// Strings leave LISP as comma-separated code points, so names survive any console encoding.
const LISP_HELPERS = [
  String.raw`(defun t3p (s) (princ (strcat "\nT3|" s "\n")) (princ))`,
  String.raw`(defun t3s (s) (if (= (type s) (quote STR)) (apply (quote strcat) (mapcar (quote (lambda (c) (strcat (itoa c) ","))) (vl-string->list s))) ""))`,
  String.raw`(defun t3n (x) (if (numberp x) (rtos x 2 6) ""))`,
];

/** Reads layouts, extents, references, and the PDF device's paper sizes and plot style tables. */
export const probeScript = () =>
  script([
    ...START,
    ...LISP_HELPERS,
    String.raw`(setvar "TILEMODE" 1)`,
    "_.ZOOM",
    "_E",
    String.raw`(t3p (strcat "V|" (itoa (getvar "PSTYLEMODE"))))`,
    String.raw`(setq t3a (getvar "EXTMIN") t3b (getvar "EXTMAX"))`,
    String.raw`(t3p (strcat "E|" (t3n (car t3a)) "|" (t3n (cadr t3a)) "|" (t3n (car t3b)) "|" (t3n (cadr t3b))))`,
    String.raw`(setq t3i 0 t3k nil)`,
    String.raw`(foreach p (dictsearch (namedobjdict) "ACAD_LAYOUT") (cond ((= (car p) 3) (setq t3k (cdr p))) ((= (car p) 350) (setq t3e (entget (cdr p))) (t3p (strcat "L|" (itoa t3i) "|" (t3n (cdr (assoc 44 t3e))) "|" (t3n (cdr (assoc 45 t3e))) "|" (t3n (cdr (assoc 73 t3e))) "|" (t3s (cdr (assoc 7 t3e))) "|" (t3s t3k))) (setq t3i (1+ t3i)))))`,
    String.raw`(setq t3r (tblnext "BLOCK" T))`,
    String.raw`(while t3r (if (= 4 (logand 4 (cdr (assoc 70 t3r)))) (t3p (strcat "X|" (t3s (cdr (assoc 1 t3r)))))) (setq t3r (tblnext "BLOCK")))`,
    String.raw`(foreach t3d (list "ACAD_IMAGE_DICT" "ACAD_PDFDEFINITIONS" "ACAD_DWFDEFINITIONS" "ACAD_DGNDEFINITIONS") (foreach p (dictsearch (namedobjdict) t3d) (if (= (car p) 350) (t3p (strcat "X|" (t3s (cdr (assoc 1 (entget (cdr p))))))))))`,
    "_.-PLOT",
    "_Y",
    "",
    "DWG To PDF.pc3",
    "?",
    "",
    "_M",
    "_L",
    "_N",
    "_E",
    "_F",
    "_C",
    "_Y",
    "?",
    "",
    "_Y",
    "_A",
    "probe.pdf",
    "_N",
    "_N",
    ...QUIT,
  ]);

export interface ProbeLayout {
  readonly index: number;
  readonly name: string;
  readonly plotStyle: string;
  readonly paperWidth: number | null;
  readonly paperHeight: number | null;
  readonly rotation: number;
}

export interface Probe {
  readonly namedPlotStyles: boolean;
  readonly extents: Bounds | null;
  readonly layouts: ReadonlyArray<ProbeLayout>;
  readonly references: ReadonlyArray<string>;
  readonly papers: ReadonlyArray<string>;
  readonly plotStyles: ReadonlyArray<string>;
}

/**
 * The console writes UTF-16 for most output and 8-bit text for some, so drop the zero bytes:
 * the T3 lines are ASCII by construction and listings are only used when ASCII.
 */
export const decodeConsole = (bytes: Uint8Array) =>
  Buffer.from(bytes.filter((byte) => byte !== 0)).toString("latin1");

const fromCodePoints = (text: string) =>
  String.fromCodePoint(
    ...text
      .split(",")
      .filter((part) => part !== "")
      .map(Number)
      .filter((code) => Number.isInteger(code) && code >= 0 && code <= 0x10ffff),
  );

const number = (text: string | undefined) => {
  const value = text === undefined || text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(value) && Math.abs(value) < 1e15 ? value : null;
};

export const parseProbe = (output: string): Probe => {
  let namedPlotStyles = false;
  let extents: Bounds | null = null;
  const layouts: ProbeLayout[] = [];
  const references: string[] = [];
  const papers: string[] = [];
  const plotStyles: string[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(/\r$/u, "");
    const listed = /^\s+"([^"]+)"\s*$/u.exec(line)?.[1];
    if (listed !== undefined) {
      if (/\.(ctb|stb)$/iu.test(listed)) plotStyles.push(listed);
      else papers.push(listed);
      continue;
    }
    if (!line.startsWith("T3|")) continue;
    const [kind, ...fields] = line.slice(3).split("|");
    if (kind === "V") namedPlotStyles = fields[0] === "0";
    else if (kind === "E") {
      const [x1, y1, x2, y2] = fields.map(number);
      if (x1 != null && y1 != null && x2 != null && y2 != null && x1 <= x2 && y1 <= y2) {
        extents = { min: [x1, y1], max: [x2, y2] };
      }
    } else if (kind === "L" && fields.length >= 6) {
      const [index, width, height, rotation, style, name] = fields;
      layouts.push({
        index: Number(index),
        name: fromCodePoints(name ?? ""),
        plotStyle: fromCodePoints(style ?? ""),
        paperWidth: number(width),
        paperHeight: number(height),
        rotation: number(rotation) ?? 0,
      });
    } else if (kind === "X" && fields[0] !== undefined) {
      references.push(fromCodePoints(fields[0]));
    }
  }
  return { namedPlotStyles, extents, layouts, references, papers, plotStyles };
};

/** Parses `ISO full bleed A2 (594.00 x 420.00 mm)`; `?` listings are localized, the dimensions are not. */
const paperDimensions = (name: string) => {
  const match = /\((\d+(?:[.,]\d+)?)\s*[xX×]\s*(\d+(?:[.,]\d+)?)\s*([^)]*)\)\s*$/u.exec(name);
  if (match === null) return undefined;
  const unit = (match[3] ?? "").trim().toLowerCase();
  const factor =
    unit.startsWith("mm") || unit.startsWith("mil")
      ? 1
      : /^(in|pul|zoll|po)/u.test(unit)
        ? 25.4
        : 0;
  if (factor === 0) return undefined;
  const width = Number(match[1]?.replace(",", ".")) * factor;
  const height = Number(match[2]?.replace(",", ".")) * factor;
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
};

/** The listed paper with `size`'s dimensions, preferring full bleed and the requested orientation. */
export const matchPaper = (
  papers: ReadonlyArray<string>,
  size: PaperSize,
  landscape: boolean,
): string | undefined => {
  const [long, short] = PAPER_SIZES[size];
  const candidates = papers.flatMap((name, order) => {
    const dimensions = paperDimensions(name);
    if (dimensions === undefined || !isPromptSafe(name)) return [];
    const { width, height } = dimensions;
    if (
      Math.abs(Math.max(width, height) - long) > 1 ||
      Math.abs(Math.min(width, height) - short) > 1
    ) {
      return [];
    }
    const rank =
      (/full bleed/iu.test(name) ? 0 : 2) + (width >= height === landscape ? 0 : 1) + order / 1e6;
    return [{ name, rank }];
  });
  return candidates.toSorted((a, b) => a.rank - b.rank)[0]?.name;
};

export interface PlotPlan {
  readonly device: "png" | "pdf";
  /** Index into the drawing's layout dictionary; `model` plots model space. */
  readonly layout: number | "model";
  /** A listed paper name; empty accepts the device's default. */
  readonly paper: string;
  readonly landscape: boolean;
  readonly area: Bounds | "extents" | "layout";
  readonly mmPerUnit: number | undefined;
  /** A listed plot style table; empty accepts the layout's own. */
  readonly plotStyle: string;
}

const point = ([x, y]: readonly [number, number]) => `${formatNumber(x)},${formatNumber(y)}`;

export const plotScript = (plan: PlotPlan) => {
  const model = plan.layout === "model";
  for (const name of [plan.paper, plan.plotStyle]) {
    if (name !== "" && !isPromptSafe(name)) throw new Error("A listed name is not prompt safe.");
  }
  if (typeof plan.layout === "number" && !Number.isSafeInteger(plan.layout)) {
    throw new Error("A layout index must be an integer.");
  }
  return script([
    ...START,
    ...(typeof plan.layout === "number"
      ? [
          String.raw`(defun t3lay (k / i r) (setq i 0) (foreach p (dictsearch (namedobjdict) "ACAD_LAYOUT") (if (= (car p) 3) (progn (if (= i k) (setq r (cdr p))) (setq i (1+ i))))) r)`,
          `(setvar "CTAB" (t3lay ${plan.layout}))`,
        ]
      : [String.raw`(setvar "TILEMODE" 1)`]),
    "_.-PLOT",
    "_Y",
    "",
    plan.device === "png" ? "PublishToWeb PNG.pc3" : "DWG To PDF.pc3",
    plan.paper,
    ...(plan.device === "pdf" ? ["_M"] : []),
    plan.landscape ? "_L" : "_P",
    "_N",
    ...(plan.area === "extents"
      ? ["_E"]
      : plan.area === "layout"
        ? ["_L"]
        : ["_W", point(plan.area.min), point(plan.area.max)]),
    plan.mmPerUnit === undefined ? "_F" : `${formatNumber(plan.mmPerUnit)}=1`,
    // A layout's offset prompt has no Center option.
    model ? "_C" : "",
    "_Y",
    plan.plotStyle,
    "_Y",
    ...(model ? ["_A"] : ["_N", "_N", "_N"]),
    plan.device === "png" ? "out.png" : "out.pdf",
    "_N",
    "_Y",
    ...QUIT,
  ]);
};

export const dxfScript = () =>
  script([...START, "_.DXFOUT", "out.dxf", "_V", "2018", "16", ...QUIT]);

/** A DXF to a DWG; with `forTemplate` its units are cleared so inserting it never rescales. */
export const dwgScript = (forTemplate: boolean) =>
  script([
    ...START,
    "_.AUDIT",
    "_Y",
    ...(forTemplate ? ["_.INSUNITS", "0"] : []),
    "_.SAVEAS",
    "2018",
    forTemplate ? "t3new.dwg" : "out.dwg",
    ...QUIT,
  ]);

/**
 * Empties a copy of the designer's drawing and inserts t3new.dwg exploded at 0,0, so its layer,
 * text and dimension style definitions win. Locked layers are unlocked only while erasing.
 */
export const templateScript = () =>
  script([
    ...START,
    String.raw`(defun t3lock (e on / d f) (setq d (entget e) f (cdr (assoc 70 d))) (entmod (subst (cons 70 (if on (logior f 4) (logand f (~ 4)))) (assoc 70 d) d)))`,
    String.raw`(setq t3lk nil t3l (tblnext "LAYER" T))`,
    String.raw`(while t3l (if (= 4 (logand 4 (cdr (assoc 70 t3l)))) (setq t3lk (cons (tblobjname "LAYER" (cdr (assoc 2 t3l))) t3lk))) (setq t3l (tblnext "LAYER")))`,
    String.raw`(foreach e t3lk (t3lock e nil))`,
    String.raw`(if (setq t3ss (ssget "_X")) (progn (setq t3i 0) (repeat (sslength t3ss) (entdel (ssname t3ss t3i)) (setq t3i (1+ t3i)))))`,
    String.raw`(setq t3u (getvar "INSUNITS"))`,
    String.raw`(setvar "INSUNITS" 0)`,
    String.raw`(setvar "INSUNITSDEFSOURCE" 0)`,
    String.raw`(setvar "INSUNITSDEFTARGET" 0)`,
    // A template saved on a layout tab would otherwise receive the geometry in paper space.
    "_.TILEMODE",
    "1",
    "_.-INSERT",
    "*t3new.dwg",
    "0,0",
    "1",
    "0",
    String.raw`(setvar "INSUNITS" t3u)`,
    String.raw`(foreach e t3lk (t3lock e T))`,
    "_.-PURGE",
    "_B",
    "*",
    "_N",
    "_.SAVEAS",
    "2018",
    "out.dwg",
    ...QUIT,
  ]);

const invalid = (message: string) => new CadError({ code: "INVALID_REQUEST", message });

const sizeOf = (bounds: Bounds) => ({
  width: bounds.max[0] - bounds.min[0],
  height: bounds.max[1] - bounds.min[1],
});

const fits = (size: PaperSize, width: number, height: number) => {
  const [long, short] = PAPER_SIZES[size];
  return Math.max(width, height) <= long + 0.5 && Math.min(width, height) <= short + 0.5;
};

const PAPER_ORDER: ReadonlyArray<PaperSize> = ["A4", "A3", "A2", "A1", "A0"];

export const planPlot = (
  input: CadExportInput & { readonly format: "png" | "pdf" },
  probe: Probe,
):
  | { readonly plan: PlotPlan; readonly paperSize?: PaperSize; readonly warnings: string[] }
  | CadError => {
  const warnings: string[] = [];
  const wanted = input.layout ?? "Model";
  const layout = probe.layouts.find(
    (candidate) => candidate.name.toLowerCase() === wanted.toLowerCase(),
  );
  const isModel = wanted.toLowerCase() === "model";
  if (layout === undefined && !isModel) {
    return invalid(
      `No layout named ${JSON.stringify(wanted)}. Layouts: ${probe.layouts.map((candidate) => candidate.name).join(", ")}.`,
    );
  }
  const area: Bounds | undefined =
    input.area === undefined
      ? undefined
      : {
          min: [input.area.min[0] ?? 0, input.area.min[1] ?? 0],
          max: [input.area.max[0] ?? 0, input.area.max[1] ?? 0],
        };
  if (area !== undefined && (area.min[0] >= area.max[0] || area.min[1] >= area.max[1])) {
    return invalid("area.min must be below and left of area.max.");
  }
  if (area !== undefined && [...area.min, ...area.max].some((value) => Math.abs(value) >= 1e15)) {
    return invalid("area coordinates must be below 1e15.");
  }
  const layoutSheet =
    !isModel && layout?.paperWidth != null && layout.paperHeight != null
      ? layout.rotation % 2 === 1
        ? { width: layout.paperHeight, height: layout.paperWidth }
        : { width: layout.paperWidth, height: layout.paperHeight }
      : undefined;
  const shape =
    area !== undefined
      ? sizeOf(area)
      : isModel
        ? probe.extents === null
          ? undefined
          : sizeOf(probe.extents)
        : layoutSheet;
  // A PNG's pixel size is fixed; portrait would only turn the drawing on its side.
  const landscape = input.format === "png" || shape === undefined || shape.width >= shape.height;

  const extension = probe.namedPlotStyles ? ".stb" : ".ctb";
  const listedStyle = (name: string) =>
    probe.plotStyles.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  let plotStyle: string;
  if (input.plotStyle !== undefined) {
    const requested = /\.(ctb|stb)$/iu.test(input.plotStyle)
      ? input.plotStyle
      : `${input.plotStyle}${extension}`;
    const listed = listedStyle(requested);
    if (
      listed === undefined ||
      !listed.toLowerCase().endsWith(extension) ||
      !isPromptSafe(listed)
    ) {
      return invalid(
        `plotStyle must be one of: ${probe.plotStyles.filter((name) => name.toLowerCase().endsWith(extension) && isPromptSafe(name)).join(", ")}.`,
      );
    }
    plotStyle = listed;
  } else {
    const own =
      (layout ?? probe.layouts.find((candidate) => candidate.name.toLowerCase() === "model"))
        ?.plotStyle ?? "";
    const listed = own === "" ? undefined : listedStyle(own);
    if (listed !== undefined) {
      plotStyle = isPromptSafe(listed) ? listed : "";
    } else {
      // Typing a table AutoCAD does not list would make it ask again and stall the script.
      const monochrome = listedStyle(`monochrome${extension}`);
      plotStyle = monochrome !== undefined && isPromptSafe(monochrome) ? monochrome : "";
      if (own !== "") {
        warnings.push(
          `The layout's plot style ${JSON.stringify(own)} was not found in the designer's plot style folder; plotted with ${plotStyle === "" ? "no plot style" : plotStyle}.`,
        );
      }
    }
  }

  const relative = probe.references.filter(
    (path) => path !== "" && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(path),
  );
  if (relative.length > 0) {
    warnings.push(
      `References by relative path don't resolve from the temporary copy, so they are missing from the plot: ${relative.slice(0, 5).join(", ")}${relative.length > 5 ? ", ..." : ""}.`,
    );
  }

  let paper = "";
  let paperSize: PaperSize | undefined;
  if (input.format === "pdf") {
    const plotted =
      input.mmPerUnit === undefined || shape === undefined
        ? undefined
        : { width: shape.width * input.mmPerUnit, height: shape.height * input.mmPerUnit };
    if (input.paper !== undefined) {
      paperSize = input.paper;
      if (plotted !== undefined && !fits(paperSize, plotted.width, plotted.height)) {
        return invalid(
          `At ${input.mmPerUnit} mm per unit the area is ${Math.round(plotted.width)} x ${Math.round(plotted.height)} mm, larger than ${paperSize}. Pass a larger paper, a smaller mmPerUnit, or a smaller area.`,
        );
      }
    } else if (plotted !== undefined) {
      paperSize = PAPER_ORDER.find((size) => fits(size, plotted.width, plotted.height));
      if (paperSize === undefined) {
        return invalid(
          `At ${input.mmPerUnit} mm per unit the area is ${Math.round(plotted.width)} x ${Math.round(plotted.height)} mm, larger than A0. Pass a smaller mmPerUnit or area.`,
        );
      }
    } else {
      paperSize =
        (layoutSheet === undefined
          ? undefined
          : PAPER_ORDER.find((size) => {
              const [long, short] = PAPER_SIZES[size];
              return (
                Math.abs(Math.max(layoutSheet.width, layoutSheet.height) - long) <= 2 &&
                Math.abs(Math.min(layoutSheet.width, layoutSheet.height) - short) <= 2
              );
            })) ?? "A3";
    }
    const listed = matchPaper(probe.papers, paperSize, landscape);
    if (listed === undefined) {
      return new CadError({
        code: "EXPORT_FAILED",
        message: `Headless AutoCAD's PDF device lists no ${paperSize} paper.`,
      });
    }
    paper = listed;
  }

  return {
    plan: {
      device: input.format,
      layout: isModel || layout === undefined ? "model" : layout.index,
      paper,
      landscape,
      area: area ?? (isModel ? "extents" : "layout"),
      mmPerUnit: input.format === "pdf" ? input.mmPerUnit : undefined,
      plotStyle,
    },
    ...(paperSize === undefined ? {} : { paperSize }),
    warnings,
  };
};

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (bytes: Uint8Array) => {
  if (bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

// Answers before the 60-second timeout most MCP clients use, across all of an export's passes.
const EXPORT_BUDGET_MS = 55_000;
const MIN_PASS_MS = 5_000;
const MAX_CONSOLE_BYTES = 4 * 1024 * 1024;

// Checked with this computer's path rules, which are the ones the files are opened with.
const windowsPaths = NodePath.sep === "\\";
const samePath = (a: string, b: string) =>
  windowsPaths ? a.toLowerCase() === b.toLowerCase() : a === b;

/** A path the agent gave: absolute, on a local drive on Windows (never a share, device or stream). */
const localPath = (path: string, field: string, extensions: ReadonlyArray<string>) => {
  const fail = () =>
    Effect.fail(
      invalid(
        `${field} must be an absolute path${windowsPaths ? " on a local drive" : ""} ending in ${extensions.join(" or ")}.`,
      ),
    );
  if (/[\p{Cc}\p{Cf}"]/u.test(path) || !NodePath.isAbsolute(path)) return fail();
  const normalized = NodePath.normalize(path);
  if (
    (windowsPaths && (!/^[A-Za-z]:\\/u.test(normalized) || normalized.includes(":", 2))) ||
    !extensions.includes(NodePath.extname(normalized).toLowerCase())
  ) {
    return fail();
  }
  return Effect.succeed(normalized);
};

const fileExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      (stats) => stats.isFile(),
      () => false,
    ),
  );

const sha256File = (path: string) =>
  Effect.promise(() =>
    NodeFSP.readFile(path).then(
      (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      () => undefined,
    ),
  );

const failure = (code: string, message: string) => new CadError({ code, message });

const ExportReceipt = Schema.Struct({
  export: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
  at: Schema.String,
});
const decodeExportReceipt = Schema.decodeUnknownOption(Schema.fromJsonString(ExportReceipt));
const encodeExportReceipt = Schema.encodeEffect(Schema.fromJsonString(ExportReceipt));

/** `Plan (T3 export 2026-11-21 163005).pdf`, in the designer's local time. */
const stampedName = (path: string, epochMillis: number) => {
  const extension = NodePath.extname(path);
  const local = DateTime.toParts(
    DateTime.setZone(DateTime.makeUnsafe(epochMillis), DateTime.zoneMakeLocal()),
  );
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`;
  return NodePath.join(
    NodePath.dirname(path),
    `${NodePath.basename(path, extension)} (T3 export ${stamp})${extension}`,
  );
};

/** `<folder>/<name>.<format>`. */
const defaultDestination = (folder: string, sourcePath: string, format: ExportFormat) =>
  NodePath.join(folder, `${NodePath.basename(sourcePath, NodePath.extname(sourcePath))}.${format}`);

export const TEMPLATE_NOTE =
  "Built on a copy of the template: model space holds only your DXF, layouts keep their page setups and viewports but nothing else, and unused blocks were purged.";

/** AutoCAD folders from the registry, newest release first. */
export const parseAcadLocations = (regOutput: string) => {
  const found: Array<{ readonly release: number; readonly folder: string }> = [];
  let release = 0;
  for (const line of regOutput.split(/\r?\n/u)) {
    const key = /\\AutoCAD\\R(\d+(?:\.\d+)?)\\/iu.exec(line);
    if (/^HKEY_/u.test(line)) release = key === null ? 0 : Number(key[1]);
    const value = /^\s+AcadLocation\s+REG_\w+\s+(.+?)\s*$/u.exec(line);
    if (value?.[1] !== undefined) found.push({ release, folder: value[1] });
  }
  return found.toSorted((a, b) => b.release - a.release).map((entry) => entry.folder);
};

export interface ExporterOptions {
  readonly stateDir: string;
  readonly platform: NodeJS.Platform;
  readonly programFiles: string | undefined;
  readonly systemRoot: string | undefined;
  /** The open AutoCAD drawings, to resolve documentIds and report unsaved changes. */
  readonly documents: Effect.Effect<ReadonlyArray<CadDocument>>;
}

export const makeExporter = Effect.fn("CadExport.makeExporter")(function* (
  options: ExporterOptions,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const { platform } = options;
  const cadDir = NodePath.join(options.stateDir, "cad");
  const receiptsFile = NodePath.join(cadDir, "receipts.jsonl");
  const profileDir = NodePath.join(cadDir, "accoreconsole");
  // Runs share one isolated AutoCAD profile, and each loads a whole drawing.
  const lock = yield* Semaphore.make(1);
  let located: string | undefined;
  const reg = NodePath.join(options.systemRoot ?? "C:\\Windows", "System32", "reg.exe");

  const locate = Effect.gen(function* () {
    if (platform !== "win32") return undefined;
    if (located !== undefined) return located;
    const output = yield* runner
      .run({
        command: reg,
        args: ["query", "HKLM\\SOFTWARE\\Autodesk\\AutoCAD", "/s", "/v", "AcadLocation"],
        timeout: "10 seconds",
      })
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.orElseSucceed(() => ""),
      );
    const programFiles = options.programFiles ?? "C:\\Program Files";
    const installed = yield* Effect.promise(() =>
      NodeFSP.readdir(NodePath.join(programFiles, "Autodesk")).catch(() => [] as string[]),
    );
    const folders = [
      ...parseAcadLocations(output),
      ...installed
        .filter((name) => /^AutoCAD 20\d\d$/u.test(name))
        .toSorted()
        .toReversed()
        .map((name) => NodePath.join(programFiles, "Autodesk", name)),
    ];
    for (const folder of folders) {
      const candidate = NodePath.join(folder, "accoreconsole.exe");
      if (yield* fileExists(candidate)) {
        located = candidate;
        return candidate;
      }
    }
    return undefined;
  });

  const headless = locate.pipe(Effect.map((path) => path !== undefined));

  const ownedExports = Effect.promise(async () => {
    const text = await NodeFSP.readFile(receiptsFile, "utf8").catch(() => "");
    const owned = new Set<string>();
    for (const line of text.split("\n")) {
      const receipt = decodeExportReceipt(line);
      if (Option.isSome(receipt))
        owned.add(ledgerKey(receipt.value.export.path, receipt.value.export.sha256));
    }
    return owned;
  });
  const ledgerKey = (path: string, sha256: string) =>
    `${windowsPaths ? path.toLowerCase() : path}\n${sha256}`;

  // The export stands even if its receipt cannot be written; the next one is then a stamped copy.
  const recordExport = Effect.fn("CadExport.recordExport")(function* (
    path: string,
    sha256: string,
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* encodeExportReceipt({ export: { path, sha256 }, at }).pipe(
      Effect.flatMap((line) =>
        Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(cadDir, { recursive: true });
            await NodeFSP.appendFile(receiptsFile, `${line}\n`);
          },
          catch: () => failure("RECEIPT_FAILED", "Could not write the export receipt."),
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not write the CAD export receipt", { error }),
      ),
    );
  });

  /** A documentId or path, and whether the open drawing has unsaved changes. */
  const resolveDrawing = Effect.fn("CadExport.resolveDrawing")(function* (
    reference: string,
    field: "source" | "template",
    extensions: ReadonlyArray<string>,
  ) {
    if (reference.startsWith("skp:")) {
      return yield* invalid(
        "cad_export works on AutoCAD drawings; SketchUp models are not supported.",
      );
    }
    let path: string;
    let document: CadDocument | undefined;
    if (reference.startsWith("acad:")) {
      document = (yield* options.documents).find((candidate) => candidate.documentId === reference);
      if (document === undefined) {
        return yield* failure(
          "DOCUMENT_NOT_FOUND",
          "Unknown documentId. Call cad_status for the open drawings.",
        );
      }
      if (document.path == null) {
        return yield* invalid(
          "This drawing has never been saved, so there is no file to export. Ask the designer to save it first.",
        );
      }
      path = yield* localPath(document.path, field, extensions);
    } else {
      path = yield* localPath(reference, field, extensions);
      // Only the designer's drawings are open in AutoCAD; DXFs are the agent's own.
      if (NodePath.extname(path).toLowerCase() !== ".dxf") {
        document = (yield* options.documents).find(
          (candidate) =>
            candidate.path != null && samePath(NodePath.normalize(candidate.path), path),
        );
      }
    }
    const stats = yield* Effect.promise(() => NodeFSP.stat(path).catch(() => undefined));
    if (stats === undefined || !stats.isFile() || stats.size === 0) {
      return yield* failure(
        "SOURCE_NOT_FOUND",
        `The ${field} file ${path} does not exist or is empty.`,
      );
    }
    return {
      path,
      savedAt: DateTime.formatIso(DateTime.makeUnsafe(stats.mtimeMs)),
      liveUnsaved: document?.modified === true,
    };
  });

  const runPass = Effect.fn("CadExport.runPass")(function* (
    accoreconsole: string,
    workDir: string,
    drawing: string,
    name: string,
    contents: string,
    deadline: number,
  ) {
    const scriptPath = NodePath.join(workDir, `${name}.scr`);
    yield* Effect.promise(() => NodeFSP.writeFile(scriptPath, contents, "latin1"));
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const timeoutMs = Math.max(MIN_PASS_MS, deadline - (yield* Clock.currentTimeMillis));
    yield* runner
      .run({
        command: accoreconsole,
        // The isolated profile copies the designer's PrinterStyleSheetDir, so their own .ctb/.stb
        // tables stay listed; only its registry and user data folders are T3's.
        args: [
          "/i",
          NodePath.join(workDir, drawing),
          "/s",
          scriptPath,
          "/isolate",
          "t3code",
          profileDir,
        ],
        cwd: workDir,
        timeout: `${timeoutMs} millis`,
        maxOutputBytes: MAX_CONSOLE_BYTES,
        outputMode: "truncate",
        onStdoutChunk: (chunk) => {
          if (bytes >= MAX_CONSOLE_BYTES) return;
          chunks.push(chunk);
          bytes += chunk.byteLength;
        },
      })
      .pipe(
        Effect.catchTags({
          ProcessTimeoutError: () =>
            Effect.fail(
              failure(
                "EXPORT_TIMEOUT",
                "Headless AutoCAD did not finish in time and was stopped. Export a smaller area, or ask the designer to check that the drawing opens without prompts.",
              ),
            ),
          ProcessSpawnError: () =>
            Effect.fail(
              failure("HOST_ERROR", "Headless AutoCAD (accoreconsole.exe) could not start."),
            ),
          ProcessStdinError: () => Effect.void,
          ProcessOutputLimitError: () => Effect.void,
          ProcessReadError: () => Effect.void,
        }),
      );
    return decodeConsole(Buffer.concat(chunks));
  });

  /**
   * Never overwrites, except a file T3 exported there before that nobody changed since. Otherwise
   * an explicit destination fails and a default one gets a stamped name.
   */
  const deliver = Effect.fn("CadExport.deliver")(function* (
    produced: string,
    target: string,
    explicit: boolean,
    sourcePath: string,
  ) {
    let path = target;
    const isSource = samePath(target, sourcePath);
    if (isSource || (yield* fileExists(target))) {
      const existing = isSource ? undefined : yield* sha256File(target);
      const owned =
        existing !== undefined && (yield* ownedExports).has(ledgerKey(target, existing));
      if (!owned) {
        if (explicit) {
          return yield* failure(
            "DESTINATION_EXISTS",
            `${target} already exists and T3 did not export it. Choose another destination; T3 never overwrites other files.`,
          );
        }
        path = stampedName(target, yield* Clock.currentTimeMillis);
      }
    }
    const replacing = path === target && !isSource && (yield* fileExists(target));
    const sha256 = yield* sha256File(produced);
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
        if (!replacing) {
          await NodeFSP.copyFile(produced, path, NodeFS.constants.COPYFILE_EXCL);
          return;
        }
        const temporary = `${path}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
        await NodeFSP.copyFile(produced, temporary, NodeFS.constants.COPYFILE_EXCL);
        await NodeFSP.rename(temporary, path).catch(async (error: unknown) => {
          await NodeFSP.rm(temporary, { force: true });
          throw error;
        });
      },
      catch: () =>
        failure(
          "EXPORT_FAILED",
          `Could not write ${path}. It may be open in another program, or the folder may be read-only.`,
        ),
    });
    if (sha256 !== undefined) yield* recordExport(path, sha256);
    return path;
  });

  /** A DXF the agent wrote, or an earlier T3 export: its exports may go beside it. */
  const ownSource = Effect.fn("CadExport.ownSource")(function* (sourcePath: string) {
    if (NodePath.extname(sourcePath).toLowerCase() === ".dxf") return true;
    const sha256 = yield* sha256File(sourcePath);
    return sha256 !== undefined && (yield* ownedExports).has(ledgerKey(sourcePath, sha256));
  });

  const exportDrawing = Effect.fn("CadExport.export")(function* (input: CadExportInput) {
    if (platform !== "win32") {
      return yield* failure("UNSUPPORTED_PLATFORM", "cad_export needs full AutoCAD on Windows.");
    }
    const plots = input.format === "png" || input.format === "pdf";
    const reject = (field: string, allowed: string) =>
      Effect.fail(invalid(`${field} applies only to ${allowed}.`));
    if (!plots) {
      for (const field of ["area", "layout", "plotStyle"] as const) {
        if (input[field] !== undefined) return yield* reject(field, "png and pdf");
      }
    }
    if (input.format !== "pdf") {
      if (input.mmPerUnit !== undefined) return yield* reject("mmPerUnit", "pdf");
      if (input.paper !== undefined) return yield* reject("paper", "pdf");
    }
    if (input.template !== undefined && input.format !== "dwg")
      return yield* reject("template", "dwg");

    const source = yield* resolveDrawing(
      input.source,
      "source",
      input.format === "dwg" ? [".dxf"] : [".dwg", ".dxf"],
    ).pipe(
      Effect.catchTags({
        CadError: (error) =>
          input.format === "dwg" &&
          error.code === "INVALID_REQUEST" &&
          !input.source.startsWith("skp:")
            ? Effect.fail(
                invalid(
                  "dwg builds a new drawing from a .dxf file you wrote; pass its absolute path as source.",
                ),
              )
            : Effect.fail(error),
      }),
    );
    const template =
      input.template === undefined
        ? undefined
        : yield* resolveDrawing(input.template, "template", [".dwg", ".dwt"]);
    const destination =
      input.destination === undefined
        ? undefined
        : yield* localPath(input.destination, "destination", [`.${input.format}`]);

    const accoreconsole = yield* locate;
    if (accoreconsole === undefined) {
      return yield* failure(
        "NOT_INSTALLED",
        "Headless AutoCAD (accoreconsole.exe) was not found. cad_export needs full AutoCAD for Windows; AutoCAD LT has no console.",
      );
    }

    const deadline = (yield* Clock.currentTimeMillis) + EXPORT_BUDGET_MS;
    const outcome = yield* lock.withPermit(
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.join(cadDir, "exports"), { recursive: true });
            return NodeFSP.mkdtemp(NodePath.join(cadDir, "exports", "run-"));
          },
          catch: () =>
            failure("EXPORT_FAILED", "Could not create T3's scratch folder for the export."),
        }),
        (workDir) =>
          Effect.gen(function* () {
            const drawing = `in${NodePath.extname(source.path).toLowerCase()}`;
            yield* Effect.tryPromise({
              try: async () => {
                await NodeFSP.copyFile(source.path, NodePath.join(workDir, drawing));
                if (template !== undefined) {
                  await NodeFSP.copyFile(template.path, NodePath.join(workDir, "template.dwg"));
                }
              },
              catch: () =>
                failure(
                  "SOURCE_NOT_FOUND",
                  "Could not copy the drawing; it may be locked or gone.",
                ),
            });
            const warnings: string[] = [];
            let areaPlotted: Bounds | "layout" | null | undefined;
            let paperSize: PaperSize | undefined;
            const output = `out.${input.format}`;
            if (input.format === "png" || input.format === "pdf") {
              const probe = parseProbe(
                yield* runPass(accoreconsole, workDir, drawing, "probe", probeScript(), deadline),
              );
              const planned = planPlot({ ...input, format: input.format }, probe);
              if (isCadError(planned)) return yield* planned;
              warnings.push(...planned.warnings);
              paperSize = planned.paperSize;
              areaPlotted = planned.plan.area === "extents" ? probe.extents : planned.plan.area;
              yield* runPass(
                accoreconsole,
                workDir,
                drawing,
                "plot",
                plotScript(planned.plan),
                deadline,
              );
            } else if (input.format === "dxf") {
              yield* runPass(accoreconsole, workDir, drawing, "dxf", dxfScript(), deadline);
            } else if (template === undefined) {
              yield* runPass(accoreconsole, workDir, drawing, "dwg", dwgScript(false), deadline);
            } else {
              yield* runPass(accoreconsole, workDir, drawing, "dwg", dwgScript(true), deadline);
              if (!(yield* nonEmpty(NodePath.join(workDir, "t3new.dwg")))) {
                return yield* failure(
                  "EXPORT_FAILED",
                  "Headless AutoCAD could not read the DXF. Check that it opens in a DXF reader such as ezdxf's audit.",
                );
              }
              yield* runPass(
                accoreconsole,
                workDir,
                "template.dwg",
                "template",
                templateScript(),
                deadline,
              );
              warnings.push(TEMPLATE_NOTE);
            }
            const produced = NodePath.join(workDir, output);
            if (!(yield* nonEmpty(produced))) {
              return yield* failure(
                "EXPORT_FAILED",
                `Headless AutoCAD produced no ${input.format}. Check that the drawing opens in AutoCAD; damaged or password-protected files cannot be exported.`,
              );
            }
            const bytes =
              input.format === "png"
                ? yield* Effect.promise(() => NodeFSP.readFile(produced))
                : undefined;
            const path =
              input.format === "png" && destination === undefined
                ? undefined
                : yield* deliver(
                    produced,
                    destination ??
                      defaultDestination(
                        (yield* ownSource(source.path))
                          ? NodePath.dirname(source.path)
                          : NodePath.join(cadDir, "exported"),
                        source.path,
                        input.format,
                      ),
                    destination !== undefined,
                    source.path,
                  );
            return { warnings, areaPlotted, paperSize, bytes, path };
          }),
        (workDir) =>
          Effect.promise(() =>
            NodeFSP.rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(
              () => undefined,
            ),
          ),
      ),
    );

    const size = outcome.bytes === undefined ? undefined : pngSize(outcome.bytes);
    return {
      format: input.format,
      ...(outcome.path === undefined ? {} : { path: outcome.path }),
      ...(outcome.bytes === undefined || size === undefined
        ? {}
        : {
            screenshot: {
              pngBase64: Buffer.from(outcome.bytes).toString("base64"),
              width: size.width,
              height: size.height,
            },
          }),
      sourcePath: source.path,
      sourceSavedAt: source.savedAt,
      ...(source.liveUnsaved ? { liveUnsaved: true as const } : {}),
      ...(outcome.areaPlotted === undefined ? {} : { areaPlotted: outcome.areaPlotted }),
      ...(outcome.paperSize === undefined ? {} : { paper: outcome.paperSize }),
      ...(input.format === "pdf" && input.mmPerUnit !== undefined
        ? { mmPerUnit: input.mmPerUnit }
        : {}),
      warnings: outcome.warnings,
      ...(input.format === "dwg" ? { next: DWG_NEXT } : {}),
    } satisfies CadExportResult;
  });

  return { headless, export: exportDrawing };
});

const nonEmpty = (path: string) =>
  Effect.promise(() =>
    NodeFSP.stat(path).then(
      (stats) => stats.isFile() && stats.size > 0,
      () => false,
    ),
  );
