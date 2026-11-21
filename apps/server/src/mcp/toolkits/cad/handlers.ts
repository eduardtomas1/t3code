import * as Effect from "effect/Effect";

import * as CadService from "../../../cad/CadService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CadCaptureToolkit, CadStandardToolkit, type CadToolkit } from "./tools.ts";

const DEFAULT_CAPTURE_SIZE = 1280;

const handlers = {
  cad_status: McpToolAccess.reads(({ app }) =>
    Effect.gen(function* () {
      const status = yield* (yield* CadService.CadService).status;
      return app === undefined
        ? status
        : {
            hosts: status.hosts.filter((host) => host.app === app),
            documents: status.documents.filter((document) => document.app === app),
          };
    }),
  ),
  // Writes only T3's own extension files into SketchUp's Plugins folder.
  cad_setup: McpToolAccess.writes(
    ({ app }) =>
      Effect.gen(function* () {
        const { results } = yield* (yield* CadService.CadService).setup;
        return {
          results: app === undefined ? results : results.filter((result) => result.app === app),
        };
      }),
    { linkedCallers: "allowed" },
  ),
  cad_get_selection: McpToolAccess.reads((input) =>
    Effect.flatMap(CadService.CadService, (cad) => cad.selection(input)),
  ),
  cad_query_objects: McpToolAccess.reads((input) =>
    Effect.flatMap(CadService.CadService, (cad) => cad.query(input)),
  ),
  cad_preview_changes: McpToolAccess.reads((input) =>
    Effect.flatMap(CadService.CadService, (cad) => cad.preview(input)),
  ),
  // The designer's dialog inside the CAD app is the approval; this only refuses read-only clients.
  cad_apply_changes: McpToolAccess.writes(
    (input) => Effect.flatMap(CadService.CadService, (cad) => cad.apply(input)),
    { linkedCallers: "allowed" },
  ),
  cad_save_copy: McpToolAccess.writes(
    (input) => Effect.flatMap(CadService.CadService, (cad) => cad.saveCopy(input)),
    { linkedCallers: "allowed" },
  ),
  cad_capture_view: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const capture = yield* (yield* CadService.CadService).capture({
        documentId: input.documentId,
        maxWidth: input.maxWidth ?? DEFAULT_CAPTURE_SIZE,
        maxHeight: input.maxHeight ?? DEFAULT_CAPTURE_SIZE,
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
} satisfies McpToolAccess.Handlers<typeof CadToolkit.tools>;

const { cad_capture_view, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(CadStandardToolkit, standardHandlers);

export const layerCapture = McpToolAccess.toLayer(CadCaptureToolkit, { cad_capture_view });
