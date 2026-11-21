import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CadService from "../../../cad/CadService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import {
  CadCaptureToolkit,
  CadExportToolkit,
  CadStandardToolkit,
  type CadToolkit,
} from "./tools.ts";

const DEFAULT_CAPTURE_SIZE = 1280;

// The server writes these files itself, outside any provider sandbox, so only a thread that may
// already write anywhere chooses where.
const requireFullAccess = (refusal: string) =>
  Effect.flatMap(loadCaller(), ({ limits }) =>
    limits.runtimeMode === "full-access"
      ? Effect.void
      : Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message: refusal })),
  );

const handlers = {
  cad_status: McpToolAccess.reads(({ app }) =>
    Effect.flatMap(CadService.CadService, (cad) => cad.status(app)),
  ),
  cad_guide: McpToolAccess.reads(({ topic }) =>
    Effect.map(CadService.CadService, (cad) => cad.guide(topic)),
  ),
  // Installs code SketchUp runs on this computer, which fenced linked work may not change.
  cad_setup: McpToolAccess.writes(
    ({ app }) =>
      requireFullAccess(
        "Only full-access threads can install the SketchUp extension. Ask the designer to run setup from one, or to install T3CodeCadBridge.rbz by hand.",
      ).pipe(Effect.andThen(Effect.flatMap(CadService.CadService, (cad) => cad.setup(app)))),
    { linkedCallers: { refused: "install extensions into CAD apps on this computer" } },
  ),
  cad_get_selection: McpToolAccess.reads((input) =>
    Effect.flatMap(CadService.CadService, (cad) => cad.selection(input)),
  ),
  cad_query_objects: McpToolAccess.reads((input) =>
    Effect.flatMap(CadService.CadService, (cad) => cad.query(input)),
  ),
  cad_document_info: McpToolAccess.reads((input) =>
    Effect.flatMap(CadService.CadService, (cad) => cad.info(input)),
  ),
  cad_preview_changes: McpToolAccess.reads((input) =>
    Effect.flatMap(CadService.CadService, (cad) => cad.preview(input)),
  ),
  // The designer's dialog inside the CAD app is the approval; this only refuses read-only clients.
  cad_apply_changes: McpToolAccess.writes(
    (input) => Effect.flatMap(CadService.CadService, (cad) => cad.apply(input)),
    { linkedCallers: "allowed" },
  ),
  // Writes a new file on this computer, which fenced linked work may not.
  cad_save_copy: McpToolAccess.writes(
    (input) =>
      (input.destination === undefined
        ? Effect.void
        : requireFullAccess(
            "Only full-access threads can choose where a copy goes. Omit destination to save it next to the original.",
          )
      ).pipe(Effect.andThen(Effect.flatMap(CadService.CadService, (cad) => cad.saveCopy(input)))),
    { linkedCallers: { refused: "write files on this computer" } },
  ),
  cad_capture_view: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const capture = yield* (yield* CadService.CadService).capture({
        documentId: input.documentId,
        maxWidth: input.maxWidth ?? DEFAULT_CAPTURE_SIZE,
        maxHeight: input.maxHeight ?? DEFAULT_CAPTURE_SIZE,
        ...(input.extents === undefined ? {} : { extents: input.extents }),
        ...(input.bbox === undefined ? {} : { bbox: input.bbox }),
      });
      return {
        documentId: capture.documentId,
        ...(capture.scene === undefined ? {} : { scene: capture.scene }),
        screenshot: {
          mimeType: "image/png" as const,
          data: capture.pngBase64,
          width: capture.width,
          height: capture.height,
        },
      };
    }),
  ),
  // Works on copies and never touches the live session, so no approval dialog applies; it still
  // writes files beside the designer's, which fenced linked work may not.
  cad_export: McpToolAccess.writes(
    (input) =>
      (input.destination === undefined
        ? Effect.void
        : requireFullAccess(
            "Only full-access threads can choose where an export goes. Omit destination to write it beside the source.",
          )
      ).pipe(
        Effect.andThen(Effect.flatMap(CadService.CadService, (cad) => cad.export(input))),
        Effect.map(({ screenshot, ...rest }) => ({
          ...rest,
          ...(screenshot === undefined
            ? {}
            : {
                screenshot: {
                  mimeType: "image/png" as const,
                  data: screenshot.pngBase64,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              }),
        })),
      ),
    { linkedCallers: { refused: "write files on this computer" } },
  ),
} satisfies McpToolAccess.Handlers<typeof CadToolkit.tools>;

const { cad_capture_view, cad_export, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(CadStandardToolkit, standardHandlers);

export const layerCapture = McpToolAccess.toLayer(CadCaptureToolkit, { cad_capture_view });

export const layerExport = McpToolAccess.toLayer(CadExportToolkit, { cad_export });
