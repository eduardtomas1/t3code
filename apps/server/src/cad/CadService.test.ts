import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import {
  CadError,
  type CadApp,
  type CadBridgeMethod,
  type CadDocument,
  type CadHost,
} from "./CadHosts.ts";
import * as CadService from "./CadService.ts";

type Answer = (params: Readonly<Record<string, unknown>>) => Effect.Effect<unknown, CadError>;

/** A host that records every bridge call and answers from a per-method script. */
const fakeHost = (
  app: CadApp,
  answers: Partial<Record<CadBridgeMethod, Answer>>,
  documents: ReadonlyArray<CadDocument> = [],
) => {
  const calls: Array<{ method: CadBridgeMethod; params: Readonly<Record<string, unknown>> }> = [];
  const host: CadHost = {
    app,
    owns: (documentId) => documentId.startsWith(app === "autocad" ? "acad:" : "skp:"),
    status: Effect.succeed({ app, state: "connected", documents }),
    call: (method, params) =>
      Effect.suspend(() => {
        calls.push({ method, params });
        const answer = answers[method];
        return answer === undefined
          ? Effect.fail(new CadError({ code: "HOST_ERROR", message: `unscripted ${method}` }))
          : answer(params);
      }),
    setup: Effect.die("setup is not scripted"),
  };
  return {
    host,
    calls,
    count: (method: CadBridgeMethod) => calls.filter((call) => call.method === method).length,
  };
};

const DOC = "acad:/plans/Plan.dwg";
const CHANGE = {
  op: "acad.set_properties",
  target: "Line 1A2",
  field: "layer",
  before: "0",
  after: "Walls",
};
const OPERATIONS = [{ op: "acad.set_properties", handles: ["1A2"], layer: "Walls" }];
const FINGERPRINTS = { "1A2": "fp-1" };

const previewing =
  (changes: ReadonlyArray<typeof CHANGE> = [CHANGE]): Answer =>
  (params) =>
    Effect.succeed({
      documentId: params.documentId,
      documentName: "Plan.dwg",
      changes,
      fingerprints: FINGERPRINTS,
      warnings: [],
    });

const applying =
  (status: "applied" | "rejected"): Answer =>
  () =>
    Effect.succeed({ status });

const failing =
  (code: string): Answer =>
  () =>
    Effect.fail(new CadError({ code, message: `${code} from the host` }));

/** Builds a CadService over `hosts`, keeping receipts under `baseDir` (a fresh temp dir by default). */
const makeCad = (hosts: ReadonlyArray<CadHost>, baseDir?: string) =>
  Effect.gen(function* () {
    const dir =
      baseDir ??
      (yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({ prefix: "t3-cad-" }));
    return yield* Effect.provide(
      Effect.service(CadService.CadService),
      CadService.layerWithHosts(hosts).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), dir)),
      ),
    );
  });

const proposeOn = (cad: CadService.CadService["Service"]) =>
  cad.preview({ documentId: DOC, operations: OPERATIONS }).pipe(
    Effect.map((preview) => {
      expect(preview.proposalId).toEqual(expect.any(String));
      return preview.proposalId as string;
    }),
  );

it.layer(NodeServices.layer)("CadService", (it) => {
  it.effect(
    "sends the previewed fingerprints, operations, and approval text to the host on apply",
    () =>
      Effect.gen(function* () {
        const fake = fakeHost("autocad", { preview: previewing(), apply: applying("applied") });
        const cad = yield* makeCad([fake.host]);

        const proposalId = yield* proposeOn(cad);
        const receipt = yield* cad.apply({ proposalId });

        expect(receipt.status).toBe("applied");
        expect(receipt.replayed).toBeUndefined();
        const sent = fake.calls.find((call) => call.method === "apply")?.params;
        expect(sent?.expectedFingerprints).toEqual(FINGERPRINTS);
        expect(sent?.operations).toEqual(OPERATIONS);
        expect(sent?.approvalMessage).toContain("Plan.dwg");
        expect(sent?.approvalMessage).toContain("• Line 1A2: layer 0 → Walls");
      }),
  );

  it.effect("applies a proposal once, replaying the receipt for repeats and concurrent calls", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const fake = fakeHost("autocad", {
        preview: previewing(),
        apply: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ status: "applied" }),
          ),
      });
      const cad = yield* makeCad([fake.host]);
      const proposalId = yield* proposeOn(cad);

      const first = yield* cad
        .apply({ proposalId })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      // Arrives while the host still holds the first apply open.
      const second = yield* cad
        .apply({ proposalId })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const firstReceipt = yield* Fiber.join(first);
      const { replayed: _replayed, ...concurrent } = yield* Fiber.join(second);
      expect(concurrent).toEqual(firstReceipt);
      const again = yield* cad.apply({ proposalId });
      expect(again).toEqual({ ...firstReceipt, replayed: true });
      expect(fake.count("apply")).toBe(1);
    }),
  );

  it.effect("maps host outcomes to receipts and never resends a timed-out proposal", () =>
    Effect.gen(function* () {
      const cases = [
        { answer: applying("rejected"), status: "rejected" },
        { answer: failing("HOST_TIMEOUT"), status: "unknown" },
        { answer: failing("HOST_DISCONNECTED"), status: "unknown" },
        { answer: failing("PARTIALLY_APPLIED"), status: "partial" },
        { answer: failing("TARGET_CHANGED"), status: "failed" },
      ] as const;
      for (const { answer, status } of cases) {
        const fake = fakeHost("autocad", { preview: previewing(), apply: answer });
        const cad = yield* makeCad([fake.host]);
        const proposalId = yield* proposeOn(cad);

        const receipt = yield* cad.apply({ proposalId });
        expect(receipt.status).toBe(status);
        if (status === "failed") expect(receipt.message).toContain("TARGET_CHANGED");
        const retry = yield* cad.apply({ proposalId });
        expect(retry).toEqual({ ...receipt, replayed: true });
        expect(fake.count("apply")).toBe(1);
      }
    }),
  );

  it.effect("refuses unknown and expired proposals", () =>
    Effect.gen(function* () {
      const fake = fakeHost("autocad", { preview: previewing(), apply: applying("applied") });
      const cad = yield* makeCad([fake.host]);

      const unknown = yield* Effect.flip(cad.apply({ proposalId: "cadp_missing" }));
      expect(unknown.code).toBe("PROPOSAL_EXPIRED");

      const proposalId = yield* proposeOn(cad);
      yield* TestClock.adjust("31 minutes");
      const expired = yield* Effect.flip(cad.apply({ proposalId }));
      expect(expired.code).toBe("PROPOSAL_EXPIRED");
      expect(fake.count("apply")).toBe(0);
    }),
  );

  it.effect("answers a retried apply from the receipt log after a restart", () =>
    Effect.gen(function* () {
      const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-cad-restart-",
      });
      const before = fakeHost("autocad", { preview: previewing(), apply: applying("applied") });
      const firstRun = yield* makeCad([before.host], baseDir);
      const proposalId = yield* proposeOn(firstRun);
      const receipt = yield* firstRun.apply({ proposalId });

      const after = fakeHost("autocad", { apply: applying("applied") });
      const secondRun = yield* makeCad([after.host], baseDir);
      expect(yield* secondRun.apply({ proposalId })).toEqual({ ...receipt, replayed: true });
      expect(after.calls).toEqual([]);
    }),
  );

  it.effect("guards previews: no-op, foreign operations, and unknown documents", () =>
    Effect.gen(function* () {
      const fake = fakeHost("autocad", { preview: previewing([]) });
      const cad = yield* makeCad([fake.host]);

      const empty = yield* cad.preview({ documentId: DOC, operations: OPERATIONS });
      expect(empty.proposalId).toBeNull();
      expect(empty.expiresAt).toBeNull();

      const foreign = yield* Effect.flip(
        cad.preview({ documentId: DOC, operations: [{ op: "skp.set_material" }] }),
      );
      expect(foreign.code).toBe("UNSUPPORTED_OPERATION");
      expect(fake.count("preview")).toBe(1);

      const missing = yield* Effect.flip(
        cad.preview({ documentId: "rhino:1", operations: OPERATIONS }),
      );
      expect(missing.code).toBe("DOCUMENT_NOT_FOUND");
    }),
  );

  it.effect("saves a copy next to the drawing by default and validates destinations", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const drawing = path.resolve("plans", "Plan.dwg");
      const document = (documentId: string, filePath: string | null): CadDocument => ({
        documentId,
        app: "autocad",
        name: "Plan.dwg",
        path: filePath,
        modified: false,
        active: true,
      });
      const fake = fakeHost(
        "autocad",
        { save_copy: (params) => Effect.succeed({ path: params.path }) },
        [document(DOC, drawing), document("acad:Drawing1", null)],
      );
      const cad = yield* makeCad([fake.host]);

      yield* cad.saveCopy({ documentId: DOC });
      const destination = String(fake.calls.at(-1)?.params.path);
      expect(path.dirname(destination)).toBe(path.dirname(drawing));
      expect(path.basename(destination)).toMatch(
        /^Plan \(T3 copy \d{4}-\d{2}-\d{2} \d{4}\)\.dwg$/u,
      );

      for (const bad of ["copy.dwg", path.resolve("plans", "copy.skp")]) {
        const error = yield* Effect.flip(cad.saveCopy({ documentId: DOC, destination: bad }));
        expect(error.code).toBe("INVALID_REQUEST");
      }
      const unsaved = yield* Effect.flip(cad.saveCopy({ documentId: "acad:Drawing1" }));
      expect(unsaved.code).toBe("DESTINATION_REQUIRED");
      expect(fake.count("save_copy")).toBe(1);
    }),
  );
});
