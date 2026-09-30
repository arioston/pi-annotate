import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function effectiveBrowserSelector(browser?: string, env = process.env): string {
  const explicit = browser?.trim() || env.PI_ANNOTATE_BROWSER?.trim();
  if (explicit) return explicit;
  if (env.BROWSER_PROFILE === undefined) return "";
  if (!/^[a-z][a-z0-9-]{0,31}$(?![\s\S])/.test(env.BROWSER_PROFILE)) throw new Error("Invalid BROWSER_PROFILE Surf label");
  return `surf:${env.BROWSER_PROFILE}`;
}

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
