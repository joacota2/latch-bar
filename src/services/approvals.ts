import { z } from "zod";
export type RpcId = string | number;
export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}
export interface RuntimeEvent {
  runId: string;
  message: RpcMessage;
}
export const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const asText = (value: unknown) =>
  typeof value === "string" ? value : "";
export const approvalKey = (runId: string, id: RpcId) =>
  JSON.stringify([runId, id]);
const paths = z.array(z.string()).nullish();
const permissionsSchema = z
  .object({
    network: z.object({ enabled: z.boolean().nullable() }).strict().nullish(),
    fileSystem: z.object({ read: paths, write: paths }).strict().nullish(),
  })
  .strict();
export interface Approval {
  key: string;
  runId: string;
  requestId: RpcId;
  method: string;
  title: string;
  details: { label: string; text: string }[];
  allowLabel: string;
  supported: boolean;
  params: Record<string, unknown>;
}
const methods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
export function parseApproval(
  runId: string,
  message: RpcMessage,
  preview?: { path: string; diff: string }[],
): Approval | null {
  if (message.id === undefined || !methods.has(message.method ?? ""))
    return null;
  const params = asRecord(message.params);
  const permission = message.method === "item/permissions/requestApproval";
  const file = message.method === "item/fileChange/requestApproval";
  const command = asText(params.command);
  const details: Approval["details"] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value)
      details.push({ label, text: value });
  };
  add("Command", command);
  add("Working directory", params.cwd);
  add("Reason", params.reason);
  let supported =
    !file || params.grantRoot == null || typeof params.grantRoot === "string";
  if (!permission && !file && !command)
    add(
      "Preview",
      "Codex did not provide a command preview with this request.",
    );
  if (permission) {
    const parsed = permissionsSchema.safeParse(params.permissions);
    supported = parsed.success;
    const scope = asRecord(params.permissions);
    const fileSystem = asRecord(scope.fileSystem);
    for (const access of ["read", "write"] as const) {
      const paths = fileSystem[access];
      if (Array.isArray(paths))
        for (const path of paths)
          add(access === "read" ? "Read access" : "Write access", path);
    }
    const network = asRecord(scope.network);
    if (typeof network.enabled === "boolean")
      add("Network access", network.enabled ? "Enabled" : "Disabled");
    if (Array.isArray(fileSystem.entries))
      for (const entry of fileSystem.entries) {
        const access = asRecord(entry);
        const path = asRecord(access.path);
        add(
          "Filesystem entry",
          `${asText(access.access)} ${asText(path.path) || asText(path.pattern) || asText(asRecord(path.value).kind)}`.trim(),
        );
      }
    if (typeof fileSystem.globScanMaxDepth === "number")
      add("Glob scan depth", String(fileSystem.globScanMaxDepth));
    add("Duration", "This turn only");
  }
  const network = asRecord(params.networkApprovalContext);
  if (network.host)
    add(
      "Network destination",
      `${asText(network.protocol)} ${asText(network.host)}`.trim(),
    );
  if (file) {
    add("Write root", params.grantRoot);
    const changes = Array.isArray(params.changes)
      ? params.changes
      : (preview ?? []);
    for (const change of changes) {
      const entry = asRecord(change);
      add("Path", entry.path);
      add("Change", entry.diff);
    }
    if (!changes.length)
      add(
        "Preview",
        "Codex did not provide a file-change preview with this request.",
      );
    add(
      "Duration",
      params.grantRoot
        ? "Writes under this root may be allowed for the rest of this session."
        : "This file-change request",
    );
  }
  if (!supported)
    add(
      "Unsupported request",
      "Latch cannot safely interpret this permission scope. Deny or cancel, and review it in Codex.",
    );
  return {
    key: approvalKey(runId, message.id),
    runId,
    requestId: message.id,
    method: message.method!,
    params,
    supported,
    details,
    title: command
      ? `The agent wants to run ${command}`
      : file
        ? "The agent wants to change files"
        : "The agent requests additional access",
    allowLabel: permission
      ? "Allow for this turn"
      : file && params.grantRoot
        ? "Allow session write access"
        : "Allow once",
  };
}
export function approvalResponse(approval: Approval, allow: boolean): unknown {
  if (allow && !approval.supported)
    throw new Error("Unsupported permission scope");
  if (approval.method !== "item/permissions/requestApproval")
    return { decision: allow ? "accept" : "decline" };
  const requested = allow
    ? permissionsSchema.parse(approval.params.permissions)
    : {};
  return {
    permissions: {
      ...(requested.network ? { network: requested.network } : {}),
      ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
    },
    scope: "turn",
  };
}
