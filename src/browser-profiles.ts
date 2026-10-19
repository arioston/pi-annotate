import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { announceDir, assertPrivatePath, claimsPath, listRecords, pidAlive, readClaims, type AnnounceRecord } from "./announce.js";

export function effectiveBrowserSelector(browser?: string, env = process.env): string {
  const explicit = browser?.trim() || env.PI_ANNOTATE_BROWSER?.trim();
  if (explicit) return explicit;
  if (env.BROWSER_PROFILE === undefined) return "";
  if (!/^[a-z][a-z0-9-]{0,31}$(?![\s\S])/.test(env.BROWSER_PROFILE)) throw new Error("Invalid BROWSER_PROFILE Surf label");
  return `surf:${env.BROWSER_PROFILE}`;
}

/** Legacy (pre-claims) label → browser ID file; read only while claims.json is absent. */
export function bindingsPath(env = process.env): string {
  return join(env.SURF_TARGETS_CONFIG_DIR || join(homedir(), ".config", "surf-targets"), "annotate-bindings.json");
}

export function parseBindings(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid annotation bindings object");
  const value = input as { version?: unknown; bindings?: unknown };
  if (value.version !== 1 || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) throw new Error("Invalid annotation bindings version or bindings");
  const seen = new Set<string>();
  for (const [label, id] of Object.entries(value.bindings)) {
    if (!/^[a-z][a-z0-9-]{0,31}$(?![\s\S])/.test(label) || typeof id !== "string" || !id.trim() || id !== id.trim() || Array.from(id).some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127) || seen.has(id)) throw new Error(`Invalid or duplicate annotation binding: ${label}`);
    seen.add(id);
  }
  return value.bindings as Record<string, string>;
}

export function boundBrowserId(selector: string, file = bindingsPath()): string {
  const label = selector.slice(5);
  if (!/^[a-z][a-z0-9-]{0,31}$(?![\s\S])/.test(label)) throw new Error(`Invalid Surf label: ${label}`);
  const labels = readFileSync(join(dirname(file), "targets.tsv"), "utf8").split("\n").filter(Boolean).map((row) => {
    const fields = row.split("\t");
    if (fields.length !== 6 || !/^[a-z][a-z0-9-]{0,31}$(?![\s\S])/.test(fields[0])) throw new Error("Invalid Surf targets.tsv row");
    return fields[0];
  });
  if (!labels.includes(label)) throw new Error(`Unknown Surf label: ${label}`);
  const bindings = parseBindings(JSON.parse(readFileSync(file, "utf8")));
  if (!Object.hasOwn(bindings, label)) throw new Error(`No annotation binding for Surf label "${label}". Open the popup and bind its browser ID.`);
  return bindings[label];
}

/**
 * Resolve the browser ID behind a reserved `surf:<label>` selector (Dalinar
 * plan 971 contract 6). Reads claims.json and the announce registry at call
 * time. When claims.json exists it is authoritative: claims[label].annotate
 * must name exactly one live announcer for that label. A live announcer is a
 * valid record whose pid is alive and whose browser ID the fork registry
 * publishes exactly once (`registryIds`). Every other case refuses with a
 * named repair; it never falls through to another profile. Installs that
 * never ran `surf-target claim import` (no claims.json) keep the legacy
 * annotate-bindings.json lookup.
 */
export function resolveSurfBrowserId(selector: string, registryIds: readonly string[], env = process.env): string {
  const label = selector.slice(5);
  if (!/^[a-z][a-z0-9-]{0,31}$(?![\s\S])/.test(label)) throw new Error(`Invalid Surf label: ${label}`);
  const claims = readClaims(claimsPath(env));
  if (claims === null) return boundBrowserId(selector, bindingsPath(env));
  const claimed = claims.claims[label]?.annotate;
  if (claimed === undefined) {
    throw new Error(`No annotate claim for Surf label "${label}". Set "${label}" as the profile label in that browser's Pi Annotate popup, then run: surf-target claim list, and surf-target claim approve ${label} --capability annotate --instance <id>`);
  }
  const directory = announceDir(env);
  assertPrivatePath(directory, "announce registry");
  const live: AnnounceRecord[] = [];
  for (const entry of listRecords(directory)) {
    if (entry.error && entry.file === `${claimed}.json`) {
      throw new Error(`Announce record for claimed instance ${claimed} is malformed (${entry.error}). Reopen that browser profile, or run: surf-target doctor --announce`);
    }
    const record = entry.record;
    if (!record || record.label !== label || record.capability !== "annotate" || !pidAlive(record.pid)) continue;
    const browserId = (record.endpoint as { browserId: string }).browserId;
    const published = registryIds.filter((id) => id === browserId).length;
    if (published > 1) throw new Error(`Browser ID "${browserId}" for ${selector} is published by ${published} native hosts. Close the duplicate profile; resolution refuses until exactly one remains.`);
    if (published === 1) live.push(record);
  }
  if (live.length === 0) {
    throw new Error(`No live Pi Annotate announcer for ${selector} (claimed instance ${claimed}). Open that browser profile and click the Pi Annotate icon, then retry. Check: surf-target claim list`);
  }
  if (live.length > 1) {
    throw new Error(`Ambiguous: ${live.length} live Pi Annotate announcers use label "${label}" (${live.map((record) => record.instanceId).join(", ")}). Clear the label in the extra profile's popup; resolution refuses until exactly one remains.`);
  }
  if (live[0].instanceId !== claimed) {
    throw new Error(`Live announcer ${live[0].instanceId} for ${selector} is not the claimed instance ${claimed}. If this profile's extension storage was reset, re-approve it: surf-target claim approve ${label} --capability annotate --instance ${live[0].instanceId} --replace`);
  }
  return (live[0].endpoint as { browserId: string }).browserId;
}
