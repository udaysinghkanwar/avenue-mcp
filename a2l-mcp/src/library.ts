import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Local file library: every downloaded course file is recorded in a manifest
 * keyed by source URL, so asking for the same file again is served from disk.
 *
 * - Cached files are re-checked with a conditional request (ETag/Last-Modified,
 *   a few ms, no body) at most every REVALIDATE_MS, or when refresh is requested.
 * - A file the user has changed locally (e.g. annotated) is never overwritten;
 *   a newer server version is saved next to it instead.
 * - Concurrent requests for the same URL share a single download.
 */

const STATE_DIR = process.env.AVENUE_STATE_DIR || path.join(os.homedir(), '.avenue-mcp');
const MANIFEST_PATH = path.join(STATE_DIR, 'library.json');
const TEXT_CACHE_DIR = path.join(STATE_DIR, 'text-cache');
const REVALIDATE_MS = 12 * 60 * 60 * 1000;
const REVALIDATE_TIMEOUT_MS = 10_000;
// Bump when text extraction changes so cached text is regenerated
const TEXT_CACHE_VERSION = 2;

interface ManifestEntry {
  path: string;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  size: number;
  mtimeMs: number;
  downloadedAt: string;
  checkedAt: string;
}

type Manifest = Record<string, ManifestEntry>;

export type LibraryStatus =
  | 'downloaded'      // first download
  | 'cached'          // served from disk, no download
  | 'updated'         // server had a newer version; local copy replaced
  | 'updated-alongside'; // newer version saved next to a locally modified copy

export interface LibraryResult {
  path: string;
  status: LibraryStatus;
  size: number;
  contentType?: string;
  note?: string;
}

export interface LibraryRequest {
  /** Canonical source URL (manifest key). */
  url: string;
  /** Where to save on first download (made unique if taken). Only called when actually downloading. */
  targetPath: () => Promise<string>;
  /** Performs the authenticated GET with extra headers. Must throw on auth failure. */
  fetch: (headers: Record<string, string>) => Promise<Response>;
  /** Whether a freshness check may run now (e.g. false if it would need an interactive login). */
  canRevalidate: () => boolean;
  /** Force a freshness check even if recently checked. */
  refresh?: boolean;
}

// ---- manifest persistence (read-modify-write, serialized within the process) ----

let writeChain: Promise<unknown> = Promise.resolve();

function readManifest(): Manifest {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function updateManifest(mutate: (m: Manifest) => void): Promise<void> {
  const next = writeChain.then(() => {
    const manifest = readManifest();
    mutate(manifest);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${MANIFEST_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, MANIFEST_PATH);
  });
  writeChain = next.catch(() => {});
  return next;
}

// ---- helpers ----

function writeAtomic(filePath: string, data: Buffer): fs.Stats {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.part`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
  return fs.statSync(filePath);
}

/** Append " (2)", " (3)"... until the path is free on disk and not claimed by another URL. */
function uniquePath(desired: string, manifest: Manifest, url: string): string {
  const claimed = new Set(Object.entries(manifest).filter(([u]) => u !== url).map(([, e]) => e.path));
  const ext = path.extname(desired);
  const base = desired.slice(0, desired.length - ext.length);
  let candidate = desired;
  for (let n = 2; fs.existsSync(candidate) || claimed.has(candidate); n++) {
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

function isLocallyModified(entry: ManifestEntry, stat: fs.Stats): boolean {
  return stat.size !== entry.size || Math.abs(stat.mtimeMs - entry.mtimeMs) > 2000;
}

function validators(res: Response) {
  return {
    etag: res.headers.get('etag') || undefined,
    lastModified: res.headers.get('last-modified') || undefined,
    contentType: res.headers.get('content-type')?.split(';')[0] || undefined,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- main entry point ----

const inFlight = new Map<string, Promise<LibraryResult>>();

export function getFile(req: LibraryRequest): Promise<LibraryResult> {
  const existing = inFlight.get(req.url);
  if (existing) return existing;
  const promise = resolveFile(req).finally(() => inFlight.delete(req.url));
  inFlight.set(req.url, promise);
  return promise;
}

async function resolveFile(req: LibraryRequest): Promise<LibraryResult> {
  const now = new Date();
  const entry = readManifest()[req.url];
  const stat = entry && fs.existsSync(entry.path) ? fs.statSync(entry.path) : null;

  if (entry && stat) {
    const cached: LibraryResult = { path: entry.path, status: 'cached', size: stat.size, contentType: entry.contentType };
    const stale = req.refresh || now.getTime() - Date.parse(entry.checkedAt) > REVALIDATE_MS;
    if (!stale) return cached;
    if (!req.canRevalidate()) return { ...cached, note: 'Served from disk; not re-checked for updates (not signed in yet).' };

    let res: Response;
    try {
      const headers: Record<string, string> = {};
      if (entry.etag) headers['If-None-Match'] = entry.etag;
      if (entry.lastModified) headers['If-Modified-Since'] = entry.lastModified;
      res = await withTimeout(req.fetch(headers), REVALIDATE_TIMEOUT_MS);
    } catch (error) {
      return { ...cached, note: `Served from disk; update check failed (${error instanceof Error ? error.message : error}).` };
    }

    if (res.status === 304) {
      await updateManifest((m) => { if (m[req.url]) m[req.url].checkedAt = now.toISOString(); });
      return cached;
    }

    const data = Buffer.from(await res.arrayBuffer());
    const meta = validators(res);

    // Some servers ignore conditional headers; identical bytes means nothing changed
    if (!isLocallyModified(entry, stat) && data.length === stat.size && data.equals(fs.readFileSync(entry.path))) {
      await updateManifest((m) => { if (m[req.url]) Object.assign(m[req.url], meta, { checkedAt: now.toISOString() }); });
      return cached;
    }

    let savePath = entry.path;
    let status: LibraryStatus = 'updated';
    if (isLocallyModified(entry, stat)) {
      // Keep the user's edited copy; put the new version beside it
      const ext = path.extname(entry.path);
      const dated = `${entry.path.slice(0, entry.path.length - ext.length)} (updated ${now.toISOString().slice(0, 10)})${ext}`;
      savePath = uniquePath(dated, readManifest(), req.url);
      status = 'updated-alongside';
    }
    const newStat = writeAtomic(savePath, data);
    await updateManifest((m) => {
      m[req.url] = { path: savePath, ...meta, size: newStat.size, mtimeMs: newStat.mtimeMs, downloadedAt: now.toISOString(), checkedAt: now.toISOString() };
    });
    return {
      path: savePath, status, size: newStat.size, contentType: meta.contentType,
      note: status === 'updated-alongside' ? `Your modified copy was kept at ${entry.path}.` : undefined,
    };
  }

  // Not downloaded yet (or the local file was deleted): download it
  const targetPath = entry ? entry.path : await req.targetPath();
  const res = await req.fetch({});
  const data = Buffer.from(await res.arrayBuffer());
  const meta = validators(res);
  // An identical file already at the target (e.g. the manifest was lost) is adopted, not duplicated
  const adoptable = !entry && fs.existsSync(targetPath)
    && !Object.entries(readManifest()).some(([u, e]) => u !== req.url && e.path === targetPath)
    && fs.readFileSync(targetPath).equals(data);
  const savePath = entry || adoptable ? targetPath : uniquePath(targetPath, readManifest(), req.url);
  const newStat = adoptable ? fs.statSync(savePath) : writeAtomic(savePath, data);
  await updateManifest((m) => {
    m[req.url] = { path: savePath, ...meta, size: newStat.size, mtimeMs: newStat.mtimeMs, downloadedAt: now.toISOString(), checkedAt: now.toISOString() };
  });
  return { path: savePath, status: 'downloaded', size: newStat.size, contentType: meta.contentType };
}

/** Look up the local copy of a URL without any network access. */
export function getCachedPath(url: string): string | null {
  const entry = readManifest()[url];
  return entry && fs.existsSync(entry.path) ? entry.path : null;
}

/**
 * Extract text from a library file, caching the result keyed by path + size + mtime
 * so large PDFs are only parsed once.
 */
export async function readTextCached(
  filePath: string,
  extract: (data: Buffer, ext: string) => Promise<string | null>
): Promise<string | null> {
  const stat = fs.statSync(filePath);
  const key = crypto.createHash('sha1').update(`v${TEXT_CACHE_VERSION}|${filePath}|${stat.size}|${stat.mtimeMs}`).digest('hex');
  const cachePath = path.join(TEXT_CACHE_DIR, `${key}.txt`);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');

  const text = await extract(fs.readFileSync(filePath), path.extname(filePath));
  if (text !== null) {
    fs.mkdirSync(TEXT_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, text);
  }
  return text;
}
