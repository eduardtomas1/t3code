// @effect-diagnostics nodeBuiltinImport:off - Loopback client for the SketchUp extension, and the discovery and plugin folders it shares with SketchUp outside T3's state.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  AUTOCAD_BRIDGE_PS1,
  SKETCHUP_LOADER_RB,
  SKETCHUP_MAIN_RB,
} from "./hostSources.generated.ts";

export const CadApp = Schema.Literals(["autocad", "sketchup"]);
export type CadApp = typeof CadApp.Type;

/** A failure the designer or agent can act on; `code` is stable, `message` says what to do. */
export class CadError extends Schema.TaggedError<CadError>()("CadError", {
  code: Schema.String,
  message: Schema.String,
}) {}
export const isCadError = Schema.is(CadError);

export const CadDocument = Schema.Struct({
  documentId: Schema.String,
  app: CadApp,
  name: Schema.String,
  path: Schema.NullOr(Schema.String),
  modified: Schema.NullOr(Schema.Boolean),
  active: Schema.Boolean,
  displayUnits: Schema.optional(Schema.NullOr(Schema.String)),
  readOnly: Schema.optional(Schema.Boolean),
  activeLayout: Schema.optional(Schema.NullOr(Schema.String)),
  revision: Schema.optional(Schema.Number),
});
export type CadDocument = typeof CadDocument.Type;

export const CadHostState = Schema.Literals([
  "connected",
  "not_running",
  "setup_required",
  "not_installed",
  "unsupported_platform",
  "busy",
  "error",
]);

export interface CadHostStatus {
  readonly app: CadApp;
  readonly state: typeof CadHostState.Type;
  readonly appVersion?: string;
  readonly bridgeVersion?: string;
  readonly hint?: string;
  readonly documents: ReadonlyArray<CadDocument>;
}

export interface CadSetupResult {
  readonly app: CadApp;
  readonly installedFor: ReadonlyArray<string>;
  readonly restartRequired: boolean;
  readonly note: string;
}

export type CadBridgeMethod =
  | "documents"
  | "selection"
  | "query"
  | "info"
  | "capture"
  | "preview"
  | "apply"
  | "save_copy";

export interface CadHost {
  readonly app: CadApp;
  readonly owns: (documentId: string) => boolean;
  readonly status: Effect.Effect<CadHostStatus>;
  /**
   * One bridge request. Fails with `HOST_TIMEOUT` or `HOST_DISCONNECTED` when the
   * request may have reached the host, so callers never treat it as not applied.
   */
  readonly call: (
    method: CadBridgeMethod,
    params: Readonly<Record<string, unknown>>,
    options: { readonly documentId: string; readonly timeoutMs: number },
  ) => Effect.Effect<unknown, CadError>;
  readonly setup: Effect.Effect<CadSetupResult, CadError>;
}

export class CadHosts extends Context.Service<
  CadHosts,
  { readonly hosts: ReadonlyArray<CadHost> }
>()("t3/cad/CadHosts") {}

const bridgeVersionOf = (source: string) => /BRIDGE_VERSION = '([^']+)'/u.exec(source)?.[1];

/** The embedded SketchUp bridge's version; status flags installs that differ. */
export const BRIDGE_VERSION = bridgeVersionOf(SKETCHUP_MAIN_RB) ?? "unknown";
/** SketchUp 2017-2019 run a Ruby that lacks APIs the bridge uses. */
const MIN_SKETCHUP_VERSION = "2020";
const PROTOCOL = 1;
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const STATUS_TIMEOUT_MS = 8_000;

const BridgeResponse = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
});
const decodeBridgeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(BridgeResponse));
const decodeDocumentList = Schema.decodeUnknownEffect(
  Schema.Struct({ documents: Schema.Array(CadDocument) }),
);
const decodeDocuments = (app: CadApp) => (value: unknown) =>
  decodeDocumentList(value).pipe(
    Effect.map((result) => result.documents),
    Effect.mapError(
      () =>
        new CadError({
          code: "HOST_ERROR",
          message: `The ${appLabel(app)} bridge listed documents in an unexpected shape. Run cad_setup to update it.`,
        }),
    ),
  );

/**
 * The request reached the host, but its answer was unreadable or too large, so it may still have
 * run. Callers treat it like `HOST_TIMEOUT`, never as "not applied".
 */
export const HOST_UNREADABLE = "HOST_UNREADABLE";

const unwrapResponse = (raw: string, app: CadApp, diagnostics = "") =>
  decodeBridgeResponse(raw).pipe(
    Effect.mapError(
      () =>
        new CadError({
          code: HOST_UNREADABLE,
          message: `The ${appLabel(app)} bridge sent an unreadable answer.${diagnostics}`,
        }),
    ),
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response.result)
        : Effect.fail(
            new CadError({
              code: response.error?.code ?? "HOST_ERROR",
              message: response.error?.message ?? `${appLabel(app)} reported an error.`,
            }),
          ),
    ),
  );

export const appLabel = (app: CadApp) => (app === "autocad" ? "AutoCAD" : "SketchUp");

const SketchUpDiscovery = Schema.Struct({
  app: Schema.Literal("sketchup"),
  pid: Schema.Int,
  port: Schema.Int,
  token: Schema.String,
  bridgeVersion: Schema.String,
  appVersion: Schema.optional(Schema.String),
});
type SketchUpEndpoint = typeof SketchUpDiscovery.Type;
const decodeDiscovery = Schema.decodeUnknownOption(Schema.fromJsonString(SketchUpDiscovery));

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Where SketchUp keeps its per-version settings folders, or undefined where SketchUp does not run. */
const sketchUpSettingsBase = (
  platform: NodeJS.Platform,
  home: string,
  appData: string | undefined,
) =>
  platform === "win32"
    ? NodePath.join(appData ?? NodePath.join(home, "AppData", "Roaming"), "SketchUp")
    : platform === "darwin"
      ? NodePath.join(home, "Library", "Application Support")
      : undefined;

/** SketchUp's per-version settings folders, which hold the Plugins folder it loads at start. */
const sketchUpVersionFolders = (base: string | undefined) =>
  Effect.promise(async () => {
    if (base === undefined) return [];
    const entries = await NodeFSP.readdir(base, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory() && /^SketchUp 20\d\d$/u.test(entry.name))
      .map((entry) => ({
        version: entry.name.slice("SketchUp ".length),
        plugins: NodePath.join(base, entry.name, "SketchUp", "Plugins"),
      }))
      .toSorted((a, b) => a.version.localeCompare(b.version));
  });

/** When T3 stops waiting, so a bridge never starts work on a request nobody will read. */
const withDeadline = (
  params: Readonly<Record<string, unknown>>,
  now: number,
  timeoutMs: number,
) => ({ ...params, deadlineAt: now + timeoutMs });

const sketchUpRequest = (
  endpoint: SketchUpEndpoint,
  method: string,
  params: Readonly<Record<string, unknown>>,
  timeoutMs: number,
) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) => {
    // Whether the request left this process decides between "not applied" and "unknown".
    const progress = { sent: false };
    const lost = (code: string, message: string) =>
      new CadError({ code: progress.sent ? code : "HOST_OFFLINE", message });
    return Effect.callback<string, CadError>((resume) => {
      const socket = NodeNet.connect({ host: "127.0.0.1", port: endpoint.port });
      let received = "";
      const fail = (code: string, message: string) => resume(Effect.fail(lost(code, message)));
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        progress.sent = true;
        socket.write(
          `${JSON.stringify({ v: PROTOCOL, id: NodeCrypto.randomUUID(), token: endpoint.token, method, params: withDeadline(params, now, timeoutMs) })}\n`,
        );
      });
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (received.length > MAX_RESPONSE_BYTES) {
          return fail(HOST_UNREADABLE, "SketchUp sent more data than T3 accepts.");
        }
        const end = received.indexOf("\n");
        if (end < 0) return;
        // One request per connection: hang up so neither side keeps an idle socket.
        socket.removeAllListeners();
        socket.destroy();
        resume(Effect.succeed(received.slice(0, end)));
      });
      socket.on("error", () => fail("HOST_DISCONNECTED", "The connection to SketchUp failed."));
      socket.on("close", () => fail("HOST_DISCONNECTED", "SketchUp closed the connection."));
      return Effect.sync(() => {
        socket.removeAllListeners();
        socket.destroy();
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            lost(
              "HOST_TIMEOUT",
              "SketchUp did not answer in time. It may be busy or showing a dialog.",
            ),
          ),
      }),
    );
  }).pipe(Effect.flatMap((raw) => unwrapResponse(raw, "sketchup")));

/** Exported so tests can point it at a temporary home and settings folder. */
export const makeSketchUpHost = (home: string, settingsBase: string | undefined): CadHost => {
  const discoveryFolder = NodePath.join(home, ".t3-cad", "hosts");

  const endpoints = Effect.promise(async () => {
    const names = await NodeFSP.readdir(discoveryFolder).catch(() => [] as string[]);
    const found: SketchUpEndpoint[] = [];
    for (const name of names) {
      if (!/^sketchup-\d+\.json$/u.test(name)) continue;
      const file = NodePath.join(discoveryFolder, name);
      const raw = await NodeFSP.readFile(file, "utf8").catch(() => undefined);
      const endpoint = raw === undefined ? undefined : decodeDiscovery(raw);
      if (endpoint === undefined || endpoint._tag === "None") continue;
      if (processAlive(endpoint.value.pid)) found.push(endpoint.value);
      // SketchUp removes its file on quit; a crash leaves one behind.
      else await NodeFSP.rm(file, { force: true }).catch(() => undefined);
    }
    return found;
  });

  const installedVersion = (plugins: string) =>
    Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(plugins, "t3_cad_bridge", "main.rb"), "utf8").then(
        bridgeVersionOf,
        () => undefined,
      ),
    );

  const endpointFor = Effect.fn("CadHosts.sketchUpEndpoint")(function* (documentId: string) {
    const pid = Number(/^skp:(\d+):/u.exec(documentId)?.[1]);
    const endpoint = (yield* endpoints).find((candidate) => candidate.pid === pid);
    if (endpoint === undefined) {
      return yield* new CadError({
        code: "DOCUMENT_NOT_FOUND",
        message: "That SketchUp window is closed. Call cad_status for the open models.",
      });
    }
    return endpoint;
  });

  const status: Effect.Effect<CadHostStatus> = Effect.gen(function* () {
    const live = yield* endpoints;
    if (live.length === 0) {
      // The newest SketchUp is the one the designer opens, so its copy decides.
      const newest = (yield* sketchUpVersionFolders(settingsBase)).at(-1);
      if (newest === undefined || newest.version < MIN_SKETCHUP_VERSION) {
        return {
          app: "sketchup",
          state: "not_installed",
          hint:
            newest === undefined
              ? "SketchUp Pro desktop was not found. Open it once after installing so it creates its settings folder."
              : `T3 needs SketchUp ${MIN_SKETCHUP_VERSION} or newer; only SketchUp ${newest.version} was found.`,
          documents: [],
        } as const;
      }
      const installed = yield* installedVersion(newest.plugins);
      return {
        app: "sketchup",
        state: installed === BRIDGE_VERSION ? "not_running" : "setup_required",
        hint:
          installed === BRIDGE_VERSION
            ? "Open SketchUp (restart it if it was open while the extension was installed)."
            : installed === undefined
              ? `Call cad_setup to install the extension for SketchUp ${newest.version}, then restart SketchUp.`
              : "The SketchUp extension is outdated. Call cad_setup, then restart SketchUp.",
        documents: [],
      } as const;
    }
    const answers = yield* Effect.forEach(live, (endpoint) =>
      sketchUpRequest(endpoint, "documents", {}, STATUS_TIMEOUT_MS).pipe(
        Effect.flatMap(decodeDocuments("sketchup")),
        Effect.result,
      ),
    );
    const documents = answers.flatMap((answer) =>
      answer._tag === "Success" ? answer.success : [],
    );
    const busy = answers.every((answer) => answer._tag === "Failure");
    const stale = live.some((endpoint) => endpoint.bridgeVersion !== BRIDGE_VERSION);
    const first = live[0];
    return {
      app: "sketchup",
      state: busy ? "busy" : "connected",
      ...(first?.appVersion === undefined ? {} : { appVersion: first.appVersion }),
      ...(first === undefined ? {} : { bridgeVersion: first.bridgeVersion }),
      ...(busy
        ? { hint: "SketchUp is running but not answering. Close any open dialog in SketchUp." }
        : stale
          ? { hint: "The SketchUp extension is outdated. Call cad_setup, then restart SketchUp." }
          : {}),
      documents,
    };
  });

  const setup: Effect.Effect<CadSetupResult, CadError> = Effect.gen(function* () {
    const found = yield* sketchUpVersionFolders(settingsBase);
    const folders = found.filter((folder) => folder.version >= MIN_SKETCHUP_VERSION);
    if (folders.length === 0) {
      return yield* new CadError({
        code: "NOT_INSTALLED",
        message:
          found.length === 0
            ? "SketchUp desktop was not found. Install SketchUp Pro or Studio and open it once, then run setup again."
            : `T3 needs SketchUp ${MIN_SKETCHUP_VERSION} or newer; only SketchUp ${found.map((folder) => folder.version).join(", ")} was found.`,
      });
    }
    yield* Effect.tryPromise({
      try: async () => {
        for (const folder of folders) {
          await NodeFSP.mkdir(NodePath.join(folder.plugins, "t3_cad_bridge"), { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(folder.plugins, "t3_cad_bridge.rb"),
            SKETCHUP_LOADER_RB,
          );
          await NodeFSP.writeFile(
            NodePath.join(folder.plugins, "t3_cad_bridge", "main.rb"),
            SKETCHUP_MAIN_RB,
          );
        }
      },
      catch: () =>
        new CadError({
          code: "SETUP_FAILED",
          message: "Could not write to SketchUp's Plugins folder. Check its permissions.",
        }),
    });
    const running = (yield* endpoints).length > 0;
    return {
      app: "sketchup",
      installedFor: folders.map((folder) => `SketchUp ${folder.version}`),
      restartRequired: running,
      note: running
        ? "Installed. Restart SketchUp so it loads the new extension."
        : "Installed. It starts the next time SketchUp opens.",
    };
  });

  return {
    app: "sketchup",
    owns: (documentId: string) => documentId.startsWith("skp:"),
    status,
    call: (method, params, { documentId, timeoutMs }) =>
      endpointFor(documentId).pipe(
        Effect.flatMap((endpoint) => sketchUpRequest(endpoint, method, params, timeoutMs)),
      ),
    setup,
  };
};

const autoCadUnsupported = new CadError({
  code: "UNSUPPORTED_PLATFORM",
  message: "AutoCAD automation needs full AutoCAD on Windows.",
});

/** Why PowerShell printed no JSON, such as an execution policy that refuses the script. */
const autoCadDiagnostics = (output: ProcessRunner.ProcessRunOutput) => {
  const stderr = output.stderr.trim();
  return ` PowerShell exited with code ${output.code ?? "unknown"}${stderr === "" ? "." : `: ${stderr.slice(-500)}`}`;
};

const AUTOCAD_STATES: Readonly<Record<string, CadHostStatus["state"]>> = {
  HOST_OFFLINE: "not_running",
  HOST_UNAVAILABLE: "not_running",
  NOT_INSTALLED: "not_installed",
  HOST_BUSY: "busy",
};

/** Exported so tests can drive it with a fake process runner. */
export const makeAutoCadHost = Effect.fn("CadHosts.makeAutoCadHost")(function* (
  platform: NodeJS.Platform,
  stateDir: string,
  powershell: string,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const digest = NodeCrypto.createHash("sha256")
    .update(AUTOCAD_BRIDGE_PS1)
    .digest("hex")
    .slice(0, 12);
  const scriptPath = NodePath.join(stateDir, "cad", `T3CadBridge-${digest}.ps1`);

  // Windows PowerShell 5.1 reads a script without a byte-order mark in the ANSI code page.
  const script = `﻿${AUTOCAD_BRIDGE_PS1}`;
  // Checked once per server run: a damaged or edited copy is replaced before PowerShell runs it.
  let verified = false;
  const ensureScript = Effect.tryPromise({
    try: async () => {
      if (verified) return;
      const existing = await NodeFSP.readFile(scriptPath, "utf8").catch(() => undefined);
      if (existing === script) {
        verified = true;
        return;
      }
      await NodeFSP.mkdir(NodePath.dirname(scriptPath), { recursive: true });
      const temporary = `${scriptPath}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
      await NodeFSP.writeFile(temporary, script);
      try {
        await NodeFSP.rename(temporary, scriptPath);
      } catch (error) {
        // A concurrent first call may have put the same script there, and Windows refuses to
        // replace a file another PowerShell is reading.
        await NodeFSP.rm(temporary, { force: true });
        if ((await NodeFSP.readFile(scriptPath, "utf8").catch(() => undefined)) !== script) {
          throw error;
        }
      }
      verified = true;
    },
    catch: () =>
      new CadError({ code: "SETUP_FAILED", message: "Could not write the AutoCAD bridge script." }),
  });

  const request = (
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Effect.Effect<unknown, CadError> =>
    platform !== "win32"
      ? Effect.fail(autoCadUnsupported)
      : ensureScript.pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((now) =>
            runner.run({
              command: powershell,
              args: [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-STA",
                "-File",
                scriptPath,
              ],
              stdin: JSON.stringify({
                v: PROTOCOL,
                id: NodeCrypto.randomUUID(),
                method,
                params: withDeadline(params, now, timeoutMs),
              }),
              timeout: `${timeoutMs} millis`,
              maxOutputBytes: MAX_RESPONSE_BYTES,
            }),
          ),
          Effect.catchTags({
            ProcessTimeoutError: () =>
              Effect.fail(
                new CadError({
                  code: "HOST_TIMEOUT",
                  message: "AutoCAD did not answer in time. It may be busy or showing a dialog.",
                }),
              ),
            ProcessSpawnError: () =>
              Effect.fail(
                new CadError({
                  code: "HOST_ERROR",
                  message: "Windows PowerShell could not start.",
                }),
              ),
            ProcessStdinError: () =>
              Effect.fail(
                new CadError({
                  code: "HOST_ERROR",
                  message: "Could not send the request to PowerShell.",
                }),
              ),
            ProcessOutputLimitError: () =>
              Effect.fail(
                new CadError({
                  code: HOST_UNREADABLE,
                  message: "AutoCAD sent more data than T3 accepts.",
                }),
              ),
            ProcessReadError: () =>
              Effect.fail(
                new CadError({
                  code: "HOST_DISCONNECTED",
                  message: "Lost the AutoCAD bridge's answer.",
                }),
              ),
          }),
          Effect.flatMap((output) =>
            unwrapResponse(output.stdout.trim(), "autocad", autoCadDiagnostics(output)),
          ),
        );

  const status: Effect.Effect<CadHostStatus> =
    platform !== "win32"
      ? Effect.succeed({
          app: "autocad",
          state: "unsupported_platform",
          hint: "AutoCAD automation needs full AutoCAD on Windows.",
          documents: [],
        } as const)
      : request("documents", {}, 30_000).pipe(
          Effect.flatMap(decodeDocuments("autocad")),
          Effect.map((documents): CadHostStatus => ({
            app: "autocad",
            state: "connected",
            bridgeVersion: BRIDGE_VERSION,
            documents,
          })),
          Effect.catchTags({
            CadError: (error) =>
              Effect.succeed<CadHostStatus>({
                app: "autocad",
                state: AUTOCAD_STATES[error.code] ?? "error",
                hint: error.message,
                documents: [],
              }),
          }),
        );

  return {
    app: "autocad",
    owns: (documentId: string) => documentId.startsWith("acad:"),
    status,
    call: (method, params, { timeoutMs }) => request(method, params, timeoutMs),
    setup: Effect.succeed({
      app: "autocad",
      installedFor: [],
      restartRequired: false,
      note:
        platform === "win32"
          ? "Nothing to install: T3 talks to the running AutoCAD directly."
          : "AutoCAD automation needs full AutoCAD on Windows.",
    }),
  } satisfies CadHost;
});

// Windows PowerShell 5.1 ships with every supported Windows; PowerShell 7 cannot reach COM objects this way.
const windowsPowerShell = (systemRoot: string | undefined) =>
  NodePath.join(
    systemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

export const layer = Layer.effect(
  CadHosts,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const appData = yield* Config.option(Config.String("APPDATA"));
    const systemRoot = yield* Config.option(Config.String("SystemRoot"));
    const home = yield* HostProcess.HomeDirectory;
    return CadHosts.of({
      hosts: [
        yield* makeAutoCadHost(
          platform,
          config.stateDir,
          windowsPowerShell(Option.getOrUndefined(systemRoot)),
        ),
        makeSketchUpHost(
          home,
          sketchUpSettingsBase(platform, home, Option.getOrUndefined(appData)),
        ),
      ],
    });
  }),
).pipe(Layer.provide(ProcessRunner.layer));
