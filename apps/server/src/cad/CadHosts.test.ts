// @effect-diagnostics nodeBuiltinImport:off -- Drives the SketchUp connector against a real loopback bridge and its discovery files, and compares the embedded bridge sources with the files on disk.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as CadHosts from "./CadHosts.ts";
import * as HostSources from "./hostSources.generated.ts";

const TOKEN = "token-for-test";
const DOCUMENT_ID = `skp:${process.pid}:model-1`;
// Above every platform's pid ceiling, so no process can own it.
const DEAD_PID = 4_194_305;

type BridgeRequest = {
  readonly v: number;
  readonly token: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
};

/**
 * A loopback stand-in for the SketchUp extension: one JSON line in, `answer`'s line out. It hangs
 * up after answering unless `keepOpen`, like the real bridge, which waits for the client to close.
 * An `undefined` answer leaves the connection open and silent.
 */
const fakeBridge = (
  answer: (request: BridgeRequest) => unknown,
  options: { readonly keepOpen?: boolean } = {},
) =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<BridgeRequest>();
    const closes = yield* Queue.unbounded<void>();
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end)) as BridgeRequest;
        Queue.offerUnsafe(requests, request);
        const response = answer(request);
        if (response === undefined) return;
        if (options.keepOpen === true) socket.write(`${JSON.stringify(response)}\n`);
        else socket.end(`${JSON.stringify(response)}\n`);
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        sockets.delete(socket);
        Queue.offerUnsafe(closes, undefined);
      });
    });
    const port = yield* Effect.acquireRelease(
      Effect.callback<number>((resume) => {
        server.listen(0, "127.0.0.1", () => {
          resume(Effect.succeed((server.address() as NodeNet.AddressInfo).port));
        });
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          for (const socket of sockets) socket.destroy();
        }),
    );
    return { port, requests, closes };
  });

/** The bridge call's CadError; an answer instead fails the test. */
const failureOf = (call: Effect.Effect<unknown, CadHosts.CadError>) =>
  call.pipe(Effect.andThen(Effect.die("expected the bridge call to fail")), Effect.flip);

/** A port nothing listens on: bound, then released. */
const closedPort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as NodeNet.AddressInfo;
    server.close(() => resume(Effect.succeed(port)));
  });
});

const writeDiscovery = (home: string, pid: number, port: number) => {
  const folder = NodePath.join(home, ".t3-cad", "hosts");
  NodeFS.mkdirSync(folder, { recursive: true });
  const file = NodePath.join(folder, `sketchup-${pid}.json`);
  NodeFS.writeFileSync(
    file,
    JSON.stringify({
      app: "sketchup",
      pid,
      port,
      token: TOKEN,
      bridgeVersion: CadHosts.BRIDGE_VERSION,
    }),
  );
  return file;
};

/** The SketchUp host over a temp home that holds its discovery files. */
const sketchUpHost = Effect.gen(function* () {
  const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    prefix: "t3-cad-home-",
  });
  return { home, host: CadHosts.makeSketchUpHost(home, undefined) };
});

it.layer(NodeServices.layer)("SketchUp connector", (it) => {
  it.effect("sends the token and method, and unwraps results and bridge errors", () =>
    Effect.gen(function* () {
      const bridge = yield* fakeBridge((request) =>
        request.method === "apply"
          ? { ok: false, error: { code: "TARGET_CHANGED", message: "Line 1A2 changed." } }
          : { ok: true, result: { method: request.method, params: request.params } },
      );
      const { home, host } = yield* sketchUpHost;
      writeDiscovery(home, process.pid, bridge.port);

      const result = yield* host.call(
        "selection",
        { documentId: DOCUMENT_ID, limit: 5 },
        { documentId: DOCUMENT_ID, timeoutMs: 5_000 },
      );
      expect(result).toEqual({
        method: "selection",
        params: { documentId: DOCUMENT_ID, limit: 5 },
      });
      expect(yield* Queue.take(bridge.requests)).toMatchObject({
        v: 1,
        token: TOKEN,
        method: "selection",
      });

      const error = yield* failureOf(
        host.call("apply", {}, { documentId: DOCUMENT_ID, timeoutMs: 5_000 }),
      );
      expect(error).toMatchObject({ code: "TARGET_CHANGED", message: "Line 1A2 changed." });
    }),
  );

  it.effect("hangs up after the answer even when the bridge keeps the connection open", () =>
    Effect.gen(function* () {
      const bridge = yield* fakeBridge(() => ({ ok: true, result: { documents: [] } }), {
        keepOpen: true,
      });
      const { home, host } = yield* sketchUpHost;
      writeDiscovery(home, process.pid, bridge.port);
      yield* host.call("documents", {}, { documentId: DOCUMENT_ID, timeoutMs: 5_000 });
      yield* Queue.take(bridge.closes);
    }),
  );

  it.effect("reports a request that got no answer as a timeout, not as offline", () =>
    Effect.gen(function* () {
      const bridge = yield* fakeBridge(() => undefined);
      const { home, host } = yield* sketchUpHost;
      writeDiscovery(home, process.pid, bridge.port);

      const pending = yield* host
        .call("apply", {}, { documentId: DOCUMENT_ID, timeoutMs: 5_000 })
        .pipe(failureOf, Effect.forkChild({ startImmediately: true }));
      // The bridge has the request, so it may act on it.
      yield* Queue.take(bridge.requests);
      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(pending)).code).toBe("HOST_TIMEOUT");
    }),
  );

  it.effect("reports a refused connection as offline", () =>
    Effect.gen(function* () {
      const port = yield* closedPort;
      const { home, host } = yield* sketchUpHost;
      writeDiscovery(home, process.pid, port);

      const error = yield* failureOf(
        host.call("apply", {}, { documentId: DOCUMENT_ID, timeoutMs: 5_000 }),
      );
      expect(error.code).toBe("HOST_OFFLINE");
    }),
  );

  it.effect("ignores and deletes the discovery file of a SketchUp that is gone", () =>
    Effect.gen(function* () {
      const bridge = yield* fakeBridge(() => ({ ok: true, result: { documents: [] } }));
      const { home, host } = yield* sketchUpHost;
      const stale = writeDiscovery(home, DEAD_PID, bridge.port);

      const error = yield* failureOf(
        host.call("selection", {}, { documentId: `skp:${DEAD_PID}:model-1`, timeoutMs: 5_000 }),
      );
      expect(error.code).toBe("DOCUMENT_NOT_FOUND");
      expect(NodeFS.existsSync(stale)).toBe(false);
      expect(yield* Queue.size(bridge.requests)).toBe(0);
    }),
  );
});

it("embeds the current bridge sources", () => {
  const onDisk = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");
  expect(HostSources.SKETCHUP_LOADER_RB).toBe(onDisk("./hosts/sketchup/t3_cad_bridge.rb"));
  expect(HostSources.SKETCHUP_MAIN_RB).toBe(onDisk("./hosts/sketchup/t3_cad_bridge/main.rb"));
  expect(HostSources.AUTOCAD_BRIDGE_PS1).toBe(onDisk("./hosts/autocad/T3CadBridge.ps1"));
});
