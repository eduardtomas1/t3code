// @effect-diagnostics nodeBuiltinImport:off - Proposal ids and the append-only receipt log the designer can audit.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as CadHosts from "./CadHosts.ts";
import { CadError, type CadApp, type CadDocument, type CadHostStatus } from "./CadHosts.ts";

const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const MAX_PROPOSALS = 200;
const READ_TIMEOUT_MS = 60_000;
// Covers the designer reading the approval dialog.
const APPLY_TIMEOUT_MS = 15 * 60 * 1000;
const SAVE_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_LINES = 18;

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
  status: Schema.Literals(["applied", "rejected"]),
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

export const CadReceipt = Schema.Struct({
  proposalId: Schema.String,
  documentId: Schema.String,
  status: Schema.Literals(["applied", "rejected", "failed", "unknown", "partial"]),
  message: Schema.String,
  changes: Schema.Array(CadChange),
  created: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  at: Schema.String,
});
export type CadReceipt = typeof CadReceipt.Type;
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
    readonly status: Effect.Effect<{
      readonly hosts: ReadonlyArray<Omit<CadHostStatus, "documents">>;
      readonly documents: ReadonlyArray<CadDocument>;
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
    readonly capture: (input: {
      readonly documentId: string;
      readonly maxWidth: number;
      readonly maxHeight: number;
    }) => Effect.Effect<typeof HostCapture.Type, CadError>;
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
    }) => Effect.Effect<CadReceipt & { readonly replayed?: true }, CadError>;
    readonly saveCopy: (input: {
      readonly documentId: string;
      readonly destination?: string | undefined;
    }) => Effect.Effect<Readonly<Record<string, unknown>>, CadError>;
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

const show = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "none";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

/** The exact text the designer approves in the CAD app's dialog. */
const approvalMessage = (documentName: string, changes: ReadonlyArray<CadChange>) => {
  const lines = changes.slice(0, MAX_APPROVAL_LINES).map((change) => {
    const line =
      change.before === undefined || change.before === null
        ? `• ${change.target}: ${show(change.after)}`
        : `• ${change.target}: ${change.field} ${show(change.before)} → ${show(change.after)}`;
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  });
  const more =
    changes.length > MAX_APPROVAL_LINES
      ? `\n…and ${changes.length - MAX_APPROVAL_LINES} more change(s).`
      : "";
  return `An agent in T3 Code wants to change ${documentName}:\n\n${lines.join("\n")}${more}\n\nApply these changes? You can undo them in one step.`;
};

const operationTitle = (operations: ReadonlyArray<CadOperation>) => {
  const kinds = [...new Set(operations.map((operation) => operation.op.replace(/^[a-z]+\./u, "")))];
  return kinds.slice(0, 3).join(", ").replaceAll("_", " ");
};

const documentLabel = (documentId: string, name: string | undefined) =>
  name ?? NodePath.basename(documentId.replace(/^acad:/u, "")) ?? documentId;

/** `Plan (T3 copy 2026-11-21 1630).dwg`, in the designer's local time. */
const copyName = (path: string, epochMillis: number) => {
  const extension = NodePath.extname(path);
  const local = DateTime.toParts(
    DateTime.setZone(DateTime.makeUnsafe(epochMillis), DateTime.zoneMakeLocal()),
  );
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}${pad(local.minute)}`;
  return NodePath.join(
    NodePath.dirname(path),
    `${NodePath.basename(path, extension)} (T3 copy ${stamp})${extension}`,
  );
};

const make = Effect.gen(function* () {
  const { hosts } = yield* CadHosts.CadHosts;
  const config = yield* ServerConfig.ServerConfig;
  const receiptsFile = NodePath.join(config.stateDir, "cad", "receipts.jsonl");
  const proposals = new Map<string, Proposal>();
  const receipts = new Map<string, CadReceipt>();
  const inFlight = new Map<string, Deferred.Deferred<CadReceipt, CadError>>();
  // CAD writes are rare and wait on a person; one at a time keeps dialogs from stacking.
  const writes = yield* Semaphore.make(1);

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

  const recordReceipt = Effect.fn("CadService.recordReceipt")(function* (receipt: CadReceipt) {
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

  // Receipts outlive a restart; proposals do not, so a retried apply still finds its outcome.
  const storedReceipt = (proposalId: string) =>
    Effect.promise(async () => {
      const cached = receipts.get(proposalId);
      if (cached !== undefined) return cached;
      const text = await NodeFSP.readFile(receiptsFile, "utf8").catch(() => "");
      for (const line of text.split("\n").reverse()) {
        if (!line.includes(proposalId)) continue;
        const receipt = decodeReceiptLine(line);
        if (receipt._tag === "Some" && receipt.value.proposalId === proposalId) {
          receipts.set(proposalId, receipt.value);
          return receipt.value;
        }
      }
      return undefined;
    });

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

  const status = Effect.gen(function* () {
    const statuses = yield* Effect.forEach(hosts, (host) => host.status, {
      concurrency: "unbounded",
    });
    return {
      hosts: statuses.map(({ documents: _documents, ...rest }) => rest),
      documents: statuses.flatMap((hostStatus) => hostStatus.documents),
    };
  }).pipe(Effect.withSpan("CadService.status"));

  const setup = Effect.fn("CadService.setup")(function* (app?: CadApp) {
    const results = yield* Effect.forEach(
      hosts.filter((host) => app === undefined || host.app === app),
      (host) => host.setup,
    );
    return { results };
  });

  const read = (
    method: "selection" | "query",
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
    return yield* read("query", input);
  });

  const capture = Effect.fn("CadService.capture")(function* (input: {
    readonly documentId: string;
    readonly maxWidth: number;
    readonly maxHeight: number;
  }) {
    const host = yield* hostFor(input.documentId);
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
      .pipe(Effect.flatMap(decodeWith(HostApply, host.app)), Effect.result);
    const app = CadHosts.appLabel(host.app);
    if (outcome._tag === "Success") {
      return outcome.success.status === "applied"
        ? {
            ...base,
            status: "applied" as const,
            message: `Applied in ${app} as one undo step. It is not saved yet; use cad_save_copy for a separate file.`,
            changes: outcome.success.changes ?? proposal.changes,
            created: outcome.success.created ?? [],
          }
        : {
            ...base,
            status: "rejected" as const,
            message: "The designer declined this change. Nothing was modified.",
          };
    }
    const error = outcome.failure;
    if (error.code === "HOST_TIMEOUT" || error.code === "HOST_DISCONNECTED") {
      return {
        ...base,
        status: "unknown" as const,
        message: `T3 lost contact with ${app} after sending this change, so it may or may not have been applied. Ask the designer to check the drawing and its undo history; this proposal is never sent again.`,
      };
    }
    if (error.code === "PARTIALLY_APPLIED") {
      return { ...base, status: "partial" as const, message: error.message };
    }
    return { ...base, status: "failed" as const, message: `${error.code}: ${error.message}` };
  });

  const apply = Effect.fn("CadService.apply")(function* (input: { readonly proposalId: string }) {
    const previous = yield* storedReceipt(input.proposalId);
    if (previous !== undefined) return { ...previous, replayed: true as const };
    const running = inFlight.get(input.proposalId);
    if (running !== undefined) return yield* Deferred.await(running);
    const proposal = proposals.get(input.proposalId);
    if (proposal === undefined || proposal.expiresAt <= (yield* Clock.currentTimeMillis)) {
      proposals.delete(input.proposalId);
      return yield* new CadError({
        code: "PROPOSAL_EXPIRED",
        message: "That proposal is unknown or expired. Call cad_preview_changes again.",
      });
    }
    const done = yield* Deferred.make<CadReceipt, CadError>();
    inFlight.set(proposal.id, done);
    // Single use: whatever happens next, this proposal is never sent to the host again.
    proposals.delete(proposal.id);
    return yield* writes.withPermit(runApply(proposal)).pipe(
      Effect.flatMap(recordReceipt),
      Effect.onExit((exit) =>
        Effect.sync(() => inFlight.delete(proposal.id)).pipe(
          Effect.andThen(Deferred.done(done, exit)),
        ),
      ),
    );
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
    if (
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
    capture,
    preview,
    apply,
    saveCopy,
  });
});

export const layer = Layer.effect(CadService, make);

/** For tests that supply their own hosts. */
export const layerWithHosts = (hosts: ReadonlyArray<CadHosts.CadHost>) =>
  layer.pipe(Layer.provide(Layer.succeed(CadHosts.CadHosts, CadHosts.CadHosts.of({ hosts }))));
