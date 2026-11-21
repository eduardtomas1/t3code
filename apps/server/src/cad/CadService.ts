// @effect-diagnostics nodeBuiltinImport:off - Proposal ids and the append-only receipt log the designer can audit.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as CadExport from "./CadExport.ts";
import * as CadHosts from "./CadHosts.ts";
import {
  CAD_GUIDE_AUTOCAD,
  CAD_GUIDE_PRESENTATION,
  CAD_GUIDE_SKETCHUP,
} from "./hostSources.generated.ts";
import { CadError, type CadApp, type CadDocument, type CadHostStatus } from "./CadHosts.ts";

const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS = 200;
// Answers before the 60-second timeout most MCP clients use.
const READ_TIMEOUT_MS = 45_000;
// Covers the designer reading the approval dialog.
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;
// How long one cad_apply_changes call waits for the designer before answering `pending`.
const APPLY_WAIT_MS = 45_000;
const SAVE_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_LINES = 18;
// Older receipts only answer retries of proposals that expired long ago.
const MAX_RECEIPT_LINES = 5000;

/**
 * Failures that leave the edit unsent or refused before the approval dialog, so it can be retried.
 * The bridges report anything after the designer's click as PARTIALLY_APPLIED, APPLY_FAILED, or
 * APPLY_UNCONFIRMED instead, so these codes never stand for a consumed proposal.
 */
const NOT_SENT_CODES = new Set([
  "HOST_BUSY",
  "HOST_OFFLINE",
  "HOST_UNAVAILABLE",
  "UNDO_DISABLED",
  "TIME_BUDGET",
  "INACTIVE_DOCUMENT",
  "DOCUMENT_NOT_FOUND",
  "NOT_INSTALLED",
  "UNSUPPORTED_PLATFORM",
  "SETUP_FAILED",
  "UNAUTHORIZED",
]);
/** Failures after the request was sent whose outcome T3 cannot know. */
const UNKNOWN_OUTCOME_CODES = new Set([
  "HOST_TIMEOUT",
  "HOST_DISCONNECTED",
  "APPLY_UNCONFIRMED",
  CadHosts.HOST_UNREADABLE,
]);

export const CadGuideTopic = Schema.Literals(["autocad", "sketchup", "presentation"]);
export type CadGuideTopic = typeof CadGuideTopic.Type;

const GUIDES: Record<CadGuideTopic, string> = {
  autocad: CAD_GUIDE_AUTOCAD,
  sketchup: CAD_GUIDE_SKETCHUP,
  presentation: CAD_GUIDE_PRESENTATION,
};

export const CadChange = Schema.Struct({
  op: Schema.String,
  target: Schema.String,
  field: Schema.String,
  before: Schema.optional(Schema.Unknown),
  after: Schema.optional(Schema.Unknown),
});
export type CadChange = typeof CadChange.Type;

const HostPreview = Schema.Struct({
  documentId: Schema.String,
  documentName: Schema.optional(Schema.String),
  changes: Schema.Array(CadChange),
  fingerprints: Schema.Record(Schema.String, Schema.String),
  warnings: Schema.Array(Schema.String),
});

const HostApply = Schema.Struct({
  status: Schema.Literals(["applied", "rejected", "expired"]),
  changes: Schema.optional(Schema.Array(CadChange)),
  created: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});

const HostCapture = Schema.Struct({
  documentId: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  pngBase64: Schema.String,
  scene: Schema.optional(Schema.NullOr(Schema.String)),
});

const HostRecord = Schema.Record(Schema.String, Schema.Unknown);

// A type alias, not an interface, so it still fits the bridge's Record params.
type CaptureInput = {
  readonly documentId: string;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly extents?: boolean;
  readonly bbox?: {
    readonly min: ReadonlyArray<number>;
    readonly max: ReadonlyArray<number>;
  };
};

export const CadReceipt = Schema.Struct({
  proposalId: Schema.String,
  documentId: Schema.String,
  status: Schema.Literals(["applied", "rejected", "expired", "failed", "unknown", "partial"]),
  message: Schema.String,
  changes: Schema.Array(CadChange),
  created: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  at: Schema.String,
});
export type CadReceipt = typeof CadReceipt.Type;

/** A receipt, or `pending` while the designer has not answered yet; never persisted. */
export const CadApplyResult = Schema.Struct({
  ...CadReceipt.fields,
  status: Schema.Literals([...CadReceipt.fields.status.literals, "pending"]),
  replayed: Schema.optional(Schema.Literal(true)),
});
export type CadApplyResult = typeof CadApplyResult.Type;
const decodeReceiptLine = Schema.decodeUnknownOption(Schema.fromJsonString(CadReceipt));
const encodeReceiptLine = Schema.encodeEffect(Schema.fromJsonString(CadReceipt));

export interface CadOperation {
  readonly op: string;
  readonly [field: string]: unknown;
}

interface Proposal {
  readonly id: string;
  readonly app: CadApp;
  readonly documentId: string;
  readonly operations: ReadonlyArray<CadOperation>;
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly changes: ReadonlyArray<CadChange>;
  readonly approvalMessage: string;
  readonly title: string;
  readonly expiresAt: number;
}

export class CadService extends Context.Service<
  CadService,
  {
    /** Asks only `app`'s host when given. */
    readonly status: (app?: CadApp) => Effect.Effect<{
      readonly hosts: ReadonlyArray<Omit<CadHostStatus, "documents">>;
      readonly documents: ReadonlyArray<CadDocument>;
      /** Whether AutoCAD's console is installed, so cad_export works. */
      readonly headless: boolean;
    }>;
    /** Sets up only `app` when given, so one app's missing install never fails the other. */
    readonly setup: (
      app?: CadApp,
    ) => Effect.Effect<{ readonly results: ReadonlyArray<CadHosts.CadSetupResult> }, CadError>;
    readonly selection: (input: {
      readonly documentId: string;
      readonly limit?: number | undefined;
    }) => Effect.Effect<Readonly<Record<string, unknown>>, CadError>;
    readonly query: (
      input: { readonly documentId: string } & Readonly<Record<string, unknown>>,
    ) => Effect.Effect<Readonly<Record<string, unknown>>, CadError>;
    readonly info: (input: {
      readonly documentId: string;
      readonly style?: boolean | undefined;
    }) => Effect.Effect<Readonly<Record<string, unknown>>, CadError>;
    readonly capture: (input: CaptureInput) => Effect.Effect<typeof HostCapture.Type, CadError>;
    readonly preview: (input: {
      readonly documentId: string;
      readonly operations: ReadonlyArray<CadOperation>;
    }) => Effect.Effect<
      {
        readonly proposalId: string | null;
        readonly documentId: string;
        readonly changes: ReadonlyArray<CadChange>;
        readonly warnings: ReadonlyArray<string>;
        readonly expiresAt: string | null;
      },
      CadError
    >;
    readonly apply: (input: {
      readonly proposalId: string;
    }) => Effect.Effect<CadApplyResult, CadError>;
    readonly saveCopy: (input: {
      readonly documentId: string;
      readonly destination?: string | undefined;
    }) => Effect.Effect<Readonly<Record<string, unknown>>, CadError>;
    readonly guide: (topic: CadGuideTopic) => {
      readonly topic: CadGuideTopic;
      readonly guide: string;
    };
    /** Runs AutoCAD's console on a copy; the open session and the original are never touched. */
    readonly export: (
      input: CadExport.CadExportInput,
    ) => Effect.Effect<CadExport.CadExportResult, CadError>;
  }
>()("t3/cad/CadService") {}

const decodeWith =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, app: CadApp) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        () =>
          new CadError({
            code: "HOST_ERROR",
            message: `The ${CadHosts.appLabel(app)} bridge answered in an unexpected shape. Run cad_setup to update it.`,
          }),
      ),
    );

// Names come from the drawing; line breaks and control or bidi characters could hide real lines.
const singleLine = (text: string) =>
  text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();

const show = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "none";
  const text = singleLine(typeof value === "string" ? value : JSON.stringify(value));
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

const opName = (op: string) => op.replace(/^[a-z]+\./u, "");
// Destructive operations first, so the line cap can never hide one.
const opRank = (op: string) => (opName(op) === "erase" ? 0 : opName(op) === "move" ? 1 : 2);

/** "Erase 500 objects", "Move 1 object", "Set layer (2)". */
const opCount = (op: string, count: number) => {
  const name = opName(op);
  if (name === "erase" || name === "move") {
    return `${name === "erase" ? "Erase" : "Move"} ${count} ${count === 1 ? "object" : "objects"}`;
  }
  const words = name.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${count})`;
};

/** The exact text the designer approves in the CAD app's dialog. */
const approvalMessage = (documentName: string, unordered: ReadonlyArray<CadChange>) => {
  const changes = unordered.toSorted((a, b) => opRank(a.op) - opRank(b.op));
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.op, (counts.get(change.op) ?? 0) + 1);
  const summary = [...counts].map(([op, count]) => opCount(op, count)).join(", ");
  const lines = changes.slice(0, MAX_APPROVAL_LINES).map((change) => {
    const target = singleLine(change.target);
    const line =
      change.before === undefined || change.before === null
        ? `• ${target}: ${show(change.after)}`
        : `• ${target}: ${singleLine(change.field)} ${show(change.before)} → ${show(change.after)}`;
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  });
  const more =
    changes.length > MAX_APPROVAL_LINES
      ? `\n…and ${changes.length - MAX_APPROVAL_LINES} more change(s).`
      : "";
  return `An agent in T3 Code wants to change ${show(documentName)}:\n${singleLine(summary)}\n\n${lines.join("\n")}${more}\n\nApply these changes? You can undo them in one step.`;
};

const operationTitle = (operations: ReadonlyArray<CadOperation>) => {
  const kinds = [...new Set(operations.map((operation) => operation.op.replace(/^[a-z]+\./u, "")))];
  return kinds.slice(0, 3).join(", ").replaceAll("_", " ");
};

const documentLabel = (documentId: string, name: string | undefined) =>
  name ?? NodePath.basename(documentId.replace(/^acad:/u, "")) ?? documentId;

/** `Plan (T3 copy 2026-11-21 163005).dwg`, in the designer's local time. */
const copyName = (path: string, epochMillis: number) => {
  const extension = NodePath.extname(path);
  const local = DateTime.toParts(
    DateTime.setZone(DateTime.makeUnsafe(epochMillis), DateTime.zoneMakeLocal()),
  );
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}${pad(local.minute)}${pad(local.second)}`;
  return NodePath.join(
    NodePath.dirname(path),
    `${NodePath.basename(path, extension)} (T3 copy ${stamp})${extension}`,
  );
};

/**
 * An agent-supplied copy path: an absolute path on a local drive, never a share, a device path,
 * or an alternate data stream, which Windows would write somewhere other than it looks.
 */
const checkDestination = (destination: string, platform: NodeJS.Platform, extension: string) => {
  const invalid = new CadError({
    code: "INVALID_REQUEST",
    message:
      platform === "win32"
        ? `destination must be an absolute path on a local drive, like C:\\Projects\\Plan copy${extension}.`
        : `destination must be an absolute path ending in ${extension}.`,
  });
  const path =
    platform === "win32"
      ? NodePath.win32.normalize(destination)
      : NodePath.posix.isAbsolute(destination)
        ? NodePath.posix.normalize(destination)
        : undefined;
  if (
    path === undefined ||
    (platform === "win32" && (!/^[A-Za-z]:\\/u.test(path) || path.includes(":", 2))) ||
    NodePath.extname(path).toLowerCase() !== extension
  ) {
    return Effect.fail(invalid);
  }
  return Effect.succeed(path);
};

const make = Effect.gen(function* () {
  const { hosts } = yield* CadHosts.CadHosts;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const receiptsFile = NodePath.join(config.stateDir, "cad", "receipts.jsonl");
  const proposals = new Map<string, Proposal>();
  const receipts = new Map<string, CadReceipt>();
  const inFlight = new Map<
    string,
    { readonly proposal: Proposal; readonly done: Deferred.Deferred<CadReceipt, CadError> }
  >();
  // CAD writes are rare and wait on a person; one at a time keeps dialogs from stacking.
  const writes = yield* Semaphore.make(1);
  const scope = yield* Effect.scope;

  const hostFor = (documentId: string): Effect.Effect<CadHosts.CadHost, CadError> => {
    const host = hosts.find((candidate) => candidate.owns(documentId));
    return host === undefined
      ? Effect.fail(
          new CadError({
            code: "DOCUMENT_NOT_FOUND",
            message: "Unknown documentId. Call cad_status for the open drawings and models.",
          }),
        )
      : Effect.succeed(host);
  };

  // Receipts outlive a restart; proposals do not, so a retried apply still finds its outcome.
  const loadReceipts = yield* Effect.cached(
    Effect.promise(async () => {
      const text = await NodeFSP.readFile(receiptsFile, "utf8").catch(() => "");
      const lines = text.split("\n").filter((line) => line !== "");
      const kept = lines.slice(-MAX_RECEIPT_LINES);
      for (const line of kept) {
        const receipt = decodeReceiptLine(line);
        if (receipt._tag === "Some") receipts.set(receipt.value.proposalId, receipt.value);
      }
      if (kept.length < lines.length) {
        const temporary = `${receiptsFile}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
        await NodeFSP.writeFile(temporary, `${kept.join("\n")}\n`)
          .then(() => NodeFSP.rename(temporary, receiptsFile))
          .catch(() => NodeFSP.rm(temporary, { force: true }));
      }
    }).pipe(Effect.withSpan("CadService.loadReceipts")),
  );

  const recordReceipt = Effect.fn("CadService.recordReceipt")(function* (receipt: CadReceipt) {
    yield* loadReceipts;
    receipts.set(receipt.proposalId, receipt);
    // The outcome stands even if the audit line cannot be written.
    yield* encodeReceiptLine(receipt).pipe(
      Effect.flatMap((line) =>
        Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.dirname(receiptsFile), { recursive: true });
          await NodeFSP.appendFile(receiptsFile, `${line}\n`);
        }),
      ),
      Effect.catch((error) => Effect.logWarning("Could not write the CAD receipt log", { error })),
    );
    return receipt;
  });

  const storedReceipt = (proposalId: string) =>
    Effect.map(loadReceipts, () => receipts.get(proposalId));

  const prune = (now: number) => {
    for (const [id, proposal] of proposals) {
      if (proposal.expiresAt <= now) proposals.delete(id);
    }
    while (proposals.size > MAX_PROPOSALS) {
      const oldest = proposals.keys().next().value;
      if (oldest === undefined) break;
      proposals.delete(oldest);
    }
  };

  const exporter = yield* CadExport.makeExporter({
    stateDir: config.stateDir,
    platform,
    programFiles: Option.getOrUndefined(yield* Config.option(Config.String("ProgramFiles"))),
    systemRoot: Option.getOrUndefined(yield* Config.option(Config.String("SystemRoot"))),
    documents: Effect.forEach(
      hosts.filter((host) => host.app === "autocad"),
      (host) => Effect.map(host.status, (hostStatus) => hostStatus.documents),
    ).pipe(Effect.map((lists) => lists.flat())),
  });

  const status = Effect.fn("CadService.status")(function* (app?: CadApp) {
    const [statuses, headless] = yield* Effect.all(
      [
        Effect.forEach(
          hosts.filter((host) => app === undefined || host.app === app),
          (host) => host.status,
          { concurrency: "unbounded" },
        ),
        exporter.headless,
      ],
      { concurrency: "unbounded" },
    );
    return {
      hosts: statuses.map(({ documents: _documents, ...rest }) => rest),
      documents: statuses.flatMap((hostStatus) => hostStatus.documents),
      headless,
    };
  });

  const setup = Effect.fn("CadService.setup")(function* (app?: CadApp) {
    const results = yield* Effect.forEach(
      hosts.filter((host) => app === undefined || host.app === app),
      (host) => host.setup,
    );
    return { results };
  });

  const read = (
    method: "selection" | "query" | "info",
    input: { readonly documentId: string } & Readonly<Record<string, unknown>>,
  ) =>
    hostFor(input.documentId).pipe(
      Effect.flatMap((host) =>
        host
          .call(method, input, { documentId: input.documentId, timeoutMs: READ_TIMEOUT_MS })
          .pipe(Effect.flatMap(decodeWith(HostRecord, host.app))),
      ),
    );

  const selection = Effect.fn("CadService.selection")(function* (input: {
    readonly documentId: string;
    readonly limit?: number | undefined;
  }) {
    return yield* read("selection", input);
  });

  const query = Effect.fn("CadService.query")(function* (
    input: { readonly documentId: string } & Readonly<Record<string, unknown>>,
  ) {
    // Units are in cad_document_info and the tool description; repeating them costs every page.
    const { units: _units, ...rows } = yield* read("query", input);
    return rows;
  });

  const info = Effect.fn("CadService.info")(function* (input: {
    readonly documentId: string;
    readonly style?: boolean | undefined;
  }) {
    const host = yield* hostFor(input.documentId);
    if (input.style === true && host.app !== "autocad") {
      return yield* new CadError({
        code: "INVALID_REQUEST",
        message: `style works only in AutoCAD; call cad_document_info without it for ${CadHosts.appLabel(host.app)}.`,
      });
    }
    return yield* read("info", input);
  });

  const capture = Effect.fn("CadService.capture")(function* (input: CaptureInput) {
    const host = yield* hostFor(input.documentId);
    if (host.app !== "autocad" && (input.extents === true || input.bbox !== undefined)) {
      return yield* new CadError({
        code: "INVALID_REQUEST",
        message: `extents and bbox work only in AutoCAD; ${CadHosts.appLabel(host.app)} captures its current view.`,
      });
    }
    const result = yield* host.call("capture", input, {
      documentId: input.documentId,
      timeoutMs: READ_TIMEOUT_MS,
    });
    return yield* decodeWith(HostCapture, host.app)(result);
  });

  const preview = Effect.fn("CadService.preview")(function* (input: {
    readonly documentId: string;
    readonly operations: ReadonlyArray<CadOperation>;
  }) {
    const host = yield* hostFor(input.documentId);
    const prefix = host.app === "autocad" ? "acad." : "skp.";
    const foreign = input.operations.find((operation) => !operation.op.startsWith(prefix));
    if (foreign !== undefined) {
      return yield* new CadError({
        code: "UNSUPPORTED_OPERATION",
        message: `${foreign.op} is not a ${CadHosts.appLabel(host.app)} operation; use ${prefix}* operations for this document.`,
      });
    }
    const result = yield* host
      .call("preview", input, { documentId: input.documentId, timeoutMs: READ_TIMEOUT_MS })
      .pipe(Effect.flatMap(decodeWith(HostPreview, host.app)));
    if (result.changes.length === 0) {
      return {
        proposalId: null,
        documentId: input.documentId,
        changes: [],
        warnings: [...result.warnings, "Nothing would change, so there is nothing to apply."],
        expiresAt: null,
      };
    }
    const now = yield* Clock.currentTimeMillis;
    prune(now);
    const id = `cadp_${NodeCrypto.randomBytes(12).toString("base64url")}`;
    const proposal: Proposal = {
      id,
      app: host.app,
      documentId: input.documentId,
      operations: input.operations,
      fingerprints: result.fingerprints,
      changes: result.changes,
      approvalMessage: approvalMessage(
        documentLabel(input.documentId, result.documentName),
        result.changes,
      ),
      title: operationTitle(input.operations),
      expiresAt: now + PROPOSAL_TTL_MS,
    };
    proposals.set(id, proposal);
    return {
      proposalId: id,
      documentId: input.documentId,
      changes: result.changes,
      warnings: result.warnings,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(proposal.expiresAt)),
    };
  });

  const unknownReceipt = (proposal: Proposal, at: string): CadReceipt => ({
    proposalId: proposal.id,
    documentId: proposal.documentId,
    changes: proposal.changes,
    created: [],
    at,
    status: "unknown",
    message: `T3 lost track of ${CadHosts.appLabel(proposal.app)} after sending this change, so it may or may not have been applied. Ask the designer to check the drawing and its undo history; this proposal is never sent again.`,
  });

  /** A receipt, or a `NOT_SENT_CODES` failure that leaves the proposal usable. */
  const runApply = Effect.fn("CadService.runApply")(function* (proposal: Proposal) {
    const host = yield* hostFor(proposal.documentId);
    const at = DateTime.formatIso(yield* DateTime.now);
    const base = {
      proposalId: proposal.id,
      documentId: proposal.documentId,
      changes: proposal.changes,
      created: [],
      at,
    };
    const outcome = yield* host
      .call(
        "apply",
        {
          documentId: proposal.documentId,
          operations: proposal.operations,
          expectedFingerprints: proposal.fingerprints,
          approvalMessage: proposal.approvalMessage,
          title: proposal.title,
        },
        { documentId: proposal.documentId, timeoutMs: APPLY_TIMEOUT_MS },
      )
      .pipe(Effect.result);
    if (outcome._tag === "Failure") {
      const error = outcome.failure;
      if (NOT_SENT_CODES.has(error.code)) return yield* error;
      if (UNKNOWN_OUTCOME_CODES.has(error.code)) return unknownReceipt(proposal, at);
      if (error.code === "PARTIALLY_APPLIED") {
        return { ...base, status: "partial" as const, message: error.message };
      }
      return { ...base, status: "failed" as const, message: `${error.code}: ${error.message}` };
    }
    const answer = yield* decodeWith(HostApply, host.app)(outcome.success).pipe(Effect.option);
    if (Option.isNone(answer)) return unknownReceipt(proposal, at);
    switch (answer.value.status) {
      case "applied":
        return {
          ...base,
          status: "applied" as const,
          message: `Applied in ${CadHosts.appLabel(host.app)} as one undo step. It is not saved yet; use cad_save_copy for a separate file.`,
          changes: answer.value.changes ?? proposal.changes,
          created: answer.value.created ?? [],
        };
      case "rejected":
        return {
          ...base,
          status: "rejected" as const,
          message: "The designer declined this change. Nothing was modified.",
        };
      case "expired":
        return {
          ...base,
          status: "expired" as const,
          message:
            "The designer did not approve this change in time, so nothing was modified. Preview it again if it is still wanted.",
        };
    }
  });

  /** Settles `proposal` into `done`; nothing that happens to the caller cancels it. */
  const settle = (proposal: Proposal, done: Deferred.Deferred<CadReceipt, CadError>) =>
    writes.withPermit(runApply(proposal)).pipe(
      Effect.flatMap(recordReceipt),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          inFlight.delete(proposal.id);
          if (Exit.isSuccess(exit)) return yield* Deferred.done(done, exit);
          const error = Exit.findErrorOption(exit);
          if (Option.isSome(error)) {
            if (proposal.expiresAt > (yield* Clock.currentTimeMillis)) {
              proposals.set(proposal.id, proposal);
            }
            return yield* Deferred.fail(done, error.value);
          }
          // Interrupted by shutdown or crashed: the host may already have the request.
          const at = DateTime.formatIso(yield* DateTime.now);
          return yield* Deferred.succeed(done, yield* recordReceipt(unknownReceipt(proposal, at)));
        }),
      ),
    );

  /** The receipt, or `pending` once this call has waited long enough for an MCP client. */
  const awaitReceipt = (proposal: Proposal, done: Deferred.Deferred<CadReceipt, CadError>) =>
    Deferred.await(done).pipe(
      Effect.timeoutOption(APPLY_WAIT_MS),
      Effect.flatMap(
        Option.match({
          onSome: (receipt): Effect.Effect<CadApplyResult> => Effect.succeed(receipt),
          onNone: () =>
            Effect.map(DateTime.now, (now) => ({
              proposalId: proposal.id,
              documentId: proposal.documentId,
              changes: proposal.changes,
              created: [],
              at: DateTime.formatIso(now),
              status: "pending" as const,
              message:
                "The designer has not answered the approval dialog yet. Call cad_apply_changes again with the same proposalId to keep waiting; it is never applied twice.",
            })),
        }),
      ),
    );

  const apply = Effect.fn("CadService.apply")(function* (input: { readonly proposalId: string }) {
    const previous = yield* storedReceipt(input.proposalId);
    if (previous !== undefined) return { ...previous, replayed: true as const };
    const running = inFlight.get(input.proposalId);
    if (running !== undefined) return yield* awaitReceipt(running.proposal, running.done);
    const proposal = proposals.get(input.proposalId);
    if (proposal === undefined || proposal.expiresAt <= (yield* Clock.currentTimeMillis)) {
      proposals.delete(input.proposalId);
      return yield* new CadError({
        code: "PROPOSAL_EXPIRED",
        message: "That proposal is unknown or expired. Call cad_preview_changes again.",
      });
    }
    const done = yield* Deferred.make<CadReceipt, CadError>();
    inFlight.set(proposal.id, { proposal, done });
    // Single use once sent: only a failure before the approval dialog puts it back.
    proposals.delete(proposal.id);
    // An aborted MCP call must not cancel an edit whose dialog the designer can still approve.
    yield* Effect.forkIn(settle(proposal, done), scope);
    return yield* awaitReceipt(proposal, done);
  });

  const saveCopy = Effect.fn("CadService.saveCopy")(function* (input: {
    readonly documentId: string;
    readonly destination?: string | undefined;
  }) {
    const host = yield* hostFor(input.documentId);
    const extension = host.app === "autocad" ? ".dwg" : ".skp";
    let destination = input.destination;
    if (destination === undefined) {
      const document = (yield* host.status).documents.find(
        (candidate) => candidate.documentId === input.documentId,
      );
      if (document?.path == null) {
        return yield* new CadError({
          code: "DESTINATION_REQUIRED",
          message: `This ${CadHosts.appLabel(host.app)} document has no file yet. Pass an absolute destination ending in ${extension}.`,
        });
      }
      destination = copyName(document.path, yield* Clock.currentTimeMillis);
    }
    if (input.destination !== undefined) {
      destination = yield* checkDestination(input.destination, platform, extension);
    } else if (
      !NodePath.isAbsolute(destination) ||
      NodePath.extname(destination).toLowerCase() !== extension
    ) {
      return yield* new CadError({
        code: "INVALID_REQUEST",
        message: `destination must be an absolute path ending in ${extension}.`,
      });
    }
    const result = yield* writes.withPermit(
      host.call(
        "save_copy",
        { documentId: input.documentId, path: destination },
        { documentId: input.documentId, timeoutMs: SAVE_TIMEOUT_MS },
      ),
    );
    return yield* decodeWith(HostRecord, host.app)(result);
  });

  return CadService.of({
    status,
    setup,
    selection,
    query,
    info,
    capture,
    preview,
    apply,
    saveCopy,
    guide: (topic) => ({ topic, guide: GUIDES[topic] }),
    export: exporter.export,
  });
});

export const layer = Layer.effect(CadService, make);

/** For tests that supply their own hosts, and optionally a fake process runner for cad_export. */
export const layerWithHosts = (
  hosts: ReadonlyArray<CadHosts.CadHost>,
  runner?: ProcessRunner.ProcessRunner["Service"],
) =>
  layer.pipe(
    Layer.provide(Layer.succeed(CadHosts.CadHosts, CadHosts.CadHosts.of({ hosts }))),
    Layer.provide(
      runner === undefined
        ? ProcessRunner.layer
        : Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of(runner)),
    ),
  );
