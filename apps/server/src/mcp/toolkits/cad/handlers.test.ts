import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
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
import { CadStandardToolkit } from "./tools.ts";

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
          documentName: "Plan.dwg",
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

const scope = (access: "full-access" | "read-only" | undefined) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId: EnvironmentId.make("environment:cad"),
    requestNamespace: "provider:cad",
    thread: {
      threadId,
      providerSessionId: "provider:cad",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: access === undefined ? undefined : { access },
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  } as McpInvocationContext.McpInvocationScope);

const run = (applied: Array<unknown>, access?: "full-access" | "read-only") =>
  Effect.provide(
    McpToolAccess.HandlersLayer.layer(CadHandlers.layerStandard).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          scope(access),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
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
        approvalMessage: expect.stringContaining("LINE 1A: layer 0 → A-WALL"),
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

it.effect("read-only clients can preview but never apply", () =>
  Effect.gen(function* () {
    const applied: Array<unknown> = [];
    yield* Effect.gen(function* () {
      const preview = yield* call("cad_preview_changes", {
        documentId,
        operations: [{ op: "acad.set_layer", handles: ["1A"], layer: "A-WALL" }],
      });
      const proposalId = (preview.result as { proposalId: string }).proposalId;
      const refused = yield* call("cad_apply_changes", { proposalId });
      expect(refused).toMatchObject({ isFailure: true, result: { code: "capability_denied" } });
      expect(applied).toHaveLength(0);
    }).pipe(run(applied, "read-only"));
  }),
);
