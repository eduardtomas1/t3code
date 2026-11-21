import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { CadError, type CadHost } from "../../../cad/CadHosts.ts";
import * as CadService from "../../../cad/CadService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CadHandlers from "./handlers.ts";
import { CadExportToolkit, CadStandardToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:cad");
const documentId = "acad:C:/Work/Plan.dwg";

const fakeAutoCad = (applied: Array<unknown>): CadHost => ({
  app: "autocad",
  owns: (id) => id.startsWith("acad:"),
  status: Effect.succeed({
    app: "autocad",
    state: "connected",
    documents: [
      {
        documentId,
        app: "autocad",
        name: "Plan.dwg",
        path: "C:/Work/Plan.dwg",
        modified: false,
        active: true,
      },
    ],
  }),
  call: (method, params) => {
    switch (method) {
      case "preview":
        return Effect.succeed({
          documentId,
          changes: [
            {
              op: "acad.set_layer",
              target: "LINE 1A",
              field: "layer",
              before: "0",
              after: "A-WALL",
            },
          ],
          fingerprints: { "entity:1A": "abc" },
          warnings: [],
        });
      case "apply":
        applied.push(params);
        return Effect.succeed({ status: "applied", created: [] });
      default:
        return Effect.fail(new CadError({ code: "HOST_BUSY", message: "AutoCAD is busy." }));
    }
  },
  setup: Effect.succeed({ app: "autocad", installedFor: [], restartRequired: false, note: "ok" }),
});

const missingSketchUp: CadHost = {
  app: "sketchup",
  owns: (id) => id.startsWith("skp:"),
  status: Effect.succeed({ app: "sketchup", state: "not_installed", documents: [] }),
  call: () => Effect.die("unused"),
  setup: Effect.fail(new CadError({ code: "NOT_INSTALLED", message: "SketchUp was not found." })),
};

type Client = McpInvocationContext.McpInvocationScope["client"];

// Paired below full access, so T3 fences what its work may change here.
const linkedClient: Client = {
  sessionId: "link:laptop",
  label: "Laptop",
  access: "approval-required",
  linked: true,
};

const scope = (client: Client) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("environment:cad"),
    requestNamespace: "provider:cad",
    thread: {
      threadId,
      providerSessionId: "provider:cad",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  } as McpInvocationContext.McpInvocationScope);

const run = (
  applied: Array<unknown>,
  client?: Client,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) =>
  Effect.provide(
    Layer.mergeAll(
      McpToolAccess.HandlersLayer.layer(CadHandlers.layerStandard),
      McpToolAccess.HandlersLayer.layer(CadHandlers.layerExport),
    ).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          scope(client),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { runtimeMode })),
          }),
          CadService.layerWithHosts([fakeAutoCad(applied), missingSketchUp]).pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-cad-tools-" })),
          ),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
  );

const call = <Name extends keyof typeof CadStandardToolkit.tools>(name: Name, params: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* CadStandardToolkit;
    const parts = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    const last = parts.at(-1);
    if (last === undefined) return yield* Effect.die(`${name} produced no result`);
    return last;
  });

const callExport = (params: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* CadExportToolkit;
    const parts = yield* toolkit
      .handle("cad_export", params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    const last = parts.at(-1);
    if (last === undefined) return yield* Effect.die("cad_export produced no result");
    return last;
  }).pipe(
    Effect.catchCause((cause) => Effect.succeed({ isFailure: true, result: Cause.squash(cause) })),
  );

it.effect("previews, applies once, and reports host failures as tool errors", () =>
  Effect.gen(function* () {
    const applied: Array<unknown> = [];
    yield* Effect.gen(function* () {
      const preview = yield* call("cad_preview_changes", {
        documentId,
        operations: [{ op: "acad.set_layer", handles: ["1A"], layer: "A-WALL" }],
      });
      expect(preview.isFailure).toBe(false);
      const proposalId = (preview.result as { proposalId: string }).proposalId;
      expect(proposalId).toMatch(/^cadp_/u);

      const first = yield* call("cad_apply_changes", { proposalId });
      expect(first.result).toMatchObject({ status: "applied", proposalId });
      const again = yield* call("cad_apply_changes", { proposalId });
      expect(again.result).toMatchObject({ status: "applied", replayed: true });
      expect(applied).toHaveLength(1);
      expect(applied[0]).toMatchObject({
        expectedFingerprints: { "entity:1A": "abc" },
        operations: [{ op: "acad.set_layer", handles: ["1A"], layer: "A-WALL" }],
      });

      const setup = yield* call("cad_setup", { app: "autocad" });
      expect(setup).toMatchObject({ isFailure: false, result: { results: [{ app: "autocad" }] } });

      const busy = yield* call("cad_get_selection", { documentId });
      expect(busy).toMatchObject({ isFailure: true, result: { code: "HOST_BUSY" } });

      const wrongApp = yield* call("cad_preview_changes", {
        documentId,
        operations: [{ op: "skp.erase", ids: ["12"] }],
      });
      expect(wrongApp).toMatchObject({
        isFailure: true,
        result: { code: "UNSUPPORTED_OPERATION" },
      });
    }).pipe(run(applied));
  }),
);

it.effect("read-only clients can read the guide and preview but never apply", () =>
  Effect.gen(function* () {
    const applied: Array<unknown> = [];
    yield* Effect.gen(function* () {
      const guide = yield* call("cad_guide", { topic: "presentation" });
      expect(guide.result).toMatchObject({ topic: "presentation" });
      const preview = yield* call("cad_preview_changes", {
        documentId,
        operations: [{ op: "acad.set_layer", handles: ["1A"], layer: "A-WALL" }],
      });
      const proposalId = (preview.result as { proposalId: string }).proposalId;
      const refused = yield* call("cad_apply_changes", { proposalId });
      expect(refused).toMatchObject({ isFailure: true, result: { code: "capability_denied" } });
      expect(applied).toHaveLength(0);
    }).pipe(run(applied, { access: "read-only" } as Client));
  }),
);

it.effect("fenced linked work may preview but not apply edits, write files or install", () =>
  Effect.gen(function* () {
    const applied: Array<unknown> = [];
    yield* Effect.gen(function* () {
      const preview = yield* call("cad_preview_changes", {
        documentId,
        operations: [{ op: "acad.set_layer", handles: ["1A"], layer: "A-WALL" }],
      });
      const proposalId = (preview.result as { proposalId: string }).proposalId;

      for (const [name, params] of [
        ["cad_apply_changes", { proposalId }],
        ["cad_save_copy", { documentId }],
        ["cad_setup", { app: "sketchup" }],
      ] as const) {
        const refused = yield* call(name, params);
        expect(refused, name).toMatchObject({
          isFailure: true,
          result: { code: "capability_denied" },
        });
      }
      expect(yield* callExport({ source: "C:\\Work\\Plan.dwg", format: "pdf" })).toMatchObject({
        isFailure: true,
        result: { code: "capability_denied" },
      });
      expect(applied).toHaveLength(0);
    }).pipe(run(applied, linkedClient));
  }),
);

it.effect("only full-access threads choose a copy's destination or install the extension", () =>
  Effect.gen(function* () {
    const saved: Array<unknown> = [];
    yield* Effect.gen(function* () {
      // Any outcome but a refusal: the default destination is allowed in every mode.
      const nextToOriginal = yield* call("cad_save_copy", { documentId });
      expect(nextToOriginal).not.toMatchObject({ result: { code: "capability_denied" } });
      for (const [name, params] of [
        ["cad_save_copy", { documentId, destination: "C:\\Work\\Elsewhere.dwg" }],
        ["cad_setup", { app: "sketchup" }],
      ] as const) {
        const refused = yield* call(name, params);
        expect(refused, name).toMatchObject({
          isFailure: true,
          result: { code: "capability_denied" },
        });
      }
      const exportTo = yield* callExport({
        source: "C:\\Work\\Plan.dwg",
        format: "pdf",
        destination: "C:\\Work\\Elsewhere.pdf",
      });
      expect(exportTo).toMatchObject({ isFailure: true, result: { code: "capability_denied" } });
    }).pipe(run(saved, undefined, "approval-required"));
  }),
);
