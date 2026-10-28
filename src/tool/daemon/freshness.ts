import type { SyntaxIndex } from "../index/index.ts";
import { configOwner, sameStamp, walkTree, type ConfigOwner } from "../index/walk.ts";

export interface FreshnessReport {
  scanMs: number;
  updateMs: number;
  paths: number;
  created: string[];
  changed: string[];
  deleted: string[];
  configChanged: Map<ConfigOwner, string[]>;
}

export type FreshnessListener = (report: FreshnessReport) => Promise<void>;

export async function bringUpToDate(index: SyntaxIndex, listeners: readonly FreshnessListener[] = []): Promise<FreshnessReport> {
  const t0 = performance.now();
  const current = walkTree(index.root);
  const created: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [path, stamp] of current) {
    const known = index.stamps.get(path);
    if (known === undefined) created.push(path);
    else if (!sameStamp(known, stamp)) changed.push(path);
  }
  for (const path of index.stamps.keys()) if (!current.has(path)) deleted.push(path);
  const t1 = performance.now();
  if (created.length + changed.length + deleted.length > 0 || index.grammarRetryDue()) await index.apply(current, [...created, ...changed], deleted);
  const configChanged = new Map<ConfigOwner, string[]>();
  for (const path of [...created, ...changed, ...deleted]) {
    const owner = configOwner(path);
    if (owner !== null) configChanged.set(owner, [...(configChanged.get(owner) ?? []), path]);
  }
  const report: FreshnessReport = {
    scanMs: t1 - t0,
    updateMs: performance.now() - t1,
    paths: current.size,
    created,
    changed,
    deleted,
    configChanged,
  };
  for (const listener of listeners) await listener(report);
  return report;
}
