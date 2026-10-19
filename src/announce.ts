// Typed entry point for the browser rendezvous contract (Dalinar plan 971).
// The implementation lives in announce.cjs so the native host, which runs
// as plain Node without a TypeScript loader, writes records with the same
// code that readers validate them with.
import { createRequire } from "node:module";

export type Capability = "surf" | "annotate";

export type AnnounceRecord = {
  version: 1;
  instanceId: string;
  label?: string;
  capability: Capability;
  browser: string;
  pid: number;
  endpoint: { socketPath: string } | { browserId: string };
  startedAt: string;
  updatedAt: string;
  endpointDeadSince?: string;
};

export type RecordEntry = { file: string; record?: AnnounceRecord; skip?: string; error?: string };

export type Claims = { version: 1; claims: Record<string, Partial<Record<Capability, string>>> };

export type AnnounceInput = {
  instanceId: string;
  label?: string;
  capability: Capability;
  browser?: string;
  pid: number;
  endpoint: { socketPath: string } | { browserId: string };
};

type AnnounceModule = {
  LABEL_PATTERN: RegExp;
  INSTANCE_PATTERN: RegExp;
  CAPABILITIES: readonly Capability[];
  announceDir(env?: NodeJS.ProcessEnv): string;
  surfTargetsConfigDir(env?: NodeJS.ProcessEnv): string;
  claimsPath(env?: NodeJS.ProcessEnv): string;
  validateRecord(parsed: unknown, fileName: string): { record?: AnnounceRecord; skip?: string; error?: string };
  readRecordFile(file: string): RecordEntry;
  listRecords(directory?: string): RecordEntry[];
  assertPrivatePath(target: string, what: string): void;
  writeRecord(input: AnnounceInput, directory?: string): AnnounceRecord;
  removeRecord(instanceId: string, pid: number, directory?: string): boolean;
  parseClaims(input: unknown): Claims;
  readClaims(file?: string): Claims | null;
  pidAlive(pid: number): boolean;
};

const require = createRequire(import.meta.url);
const announce = require("./announce.cjs") as AnnounceModule;

export const LABEL_PATTERN = announce.LABEL_PATTERN;
export const INSTANCE_PATTERN = announce.INSTANCE_PATTERN;
export const CAPABILITIES = announce.CAPABILITIES;
export const announceDir = announce.announceDir;
export const surfTargetsConfigDir = announce.surfTargetsConfigDir;
export const claimsPath = announce.claimsPath;
export const validateRecord = announce.validateRecord;
export const readRecordFile = announce.readRecordFile;
export const listRecords = announce.listRecords;
export const assertPrivatePath = announce.assertPrivatePath;
export const writeRecord = announce.writeRecord;
export const removeRecord = announce.removeRecord;
export const parseClaims = announce.parseClaims;
export const readClaims = announce.readClaims;
export const pidAlive = announce.pidAlive;
