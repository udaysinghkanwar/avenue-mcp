import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getD2LCookies, hasActiveSession, clearTokenCache } from '../auth.js';
import { client } from '../client.js';
import { findCourse, courseDir, sanitizeName } from '../courses.js';
import { getFile, readTextCached } from '../library.js';
import mammoth from 'mammoth';
import JSZip from 'jszip';

const D2L_HOST = process.env.D2L_HOST || 'learn.ul.ie';

// Extract text content from various file types
export async function extractContent(data: Buffer, ext: string): Promise<string | null> {
  const lowerExt = ext.toLowerCase();
  
  // Text-based files - return as string
  if (['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm', '.css', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h'].includes(lowerExt)) {
    return data.toString('utf-8');
  }
  
  // Word documents - extract text with multiple fallback methods
  if (lowerExt === '.docx') {
    // Method 1: Try macOS textutil (most reliable on Mac)
    if (os.platform() === 'darwin') {
      try {
        // Write buffer to temp file
        const tempFile = path.join(os.tmpdir(), `docx-extract-${Date.now()}.docx`);
        fs.writeFileSync(tempFile, data);
        
        // Use textutil to convert to plain text
        const textOutput = execSync(`textutil -convert txt -stdout "${tempFile}"`, {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        });
        
        // Clean up temp file
        try {
          fs.unlinkSync(tempFile);
        } catch {}
        
        if (textOutput && textOutput.trim().length > 0) {
          console.error(`[DOCX] Successfully extracted text using macOS textutil`);
          return textOutput.trim();
        }
      } catch (textutilError: any) {
        console.error(`[DOCX] textutil failed: ${textutilError?.message || textutilError}`);
        // Continue to next method
      }
    }
    
    // Method 2: Try mammoth extractRawText
    try {
      const result = await mammoth.extractRawText({ buffer: data });
      if (result.value && result.value.trim().length > 0) {
        console.error(`[DOCX] Successfully extracted text using mammoth.extractRawText`);
        return result.value;
      }
      
      if (result.messages && result.messages.length > 0) {
        console.error(`[DOCX] Warnings from extractRawText:`, result.messages.map((m: any) => m.message).join(', '));
      }
    } catch (mammothError: any) {
      console.error(`[DOCX] mammoth.extractRawText failed: ${mammothError?.message || mammothError}`);
    }
    
    // Method 3: Try mammoth convertToHtml
    try {
      const htmlResult = await mammoth.convertToHtml({ buffer: data });
      if (htmlResult.value) {
        // Strip HTML tags and decode entities
        const text = htmlResult.value
          .replace(/<style[^>]*>.*?<\/style>/gi, ' ') // Remove style tags
          .replace(/<script[^>]*>.*?<\/script>/gi, ' ') // Remove script tags
          .replace(/<[^>]*>/g, ' ') // Remove HTML tags
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
          .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/&[^;]+;/g, ' ') // Remove any remaining entities
          .replace(/\s+/g, ' ') // Normalize whitespace
          .trim();
        if (text.length > 0) {
          console.error(`[DOCX] Successfully extracted text using mammoth.convertToHtml`);
          return text;
        }
      }
      if (htmlResult.messages && htmlResult.messages.length > 0) {
        console.error(`[DOCX] Warnings from convertToHtml:`, htmlResult.messages.map((m: any) => m.message).join(', '));
      }
    } catch (htmlError: any) {
      console.error(`[DOCX] mammoth.convertToHtml failed: ${htmlError?.message || htmlError}`);
    }
    
    console.error(`[DOCX] All extraction methods failed - could not extract text from DOCX file`);
    return null;
  }
  
  // Old .doc format (not supported by mammoth)
  if (lowerExt === '.doc') {
    console.error(`[DOC] Old .doc format not supported by mammoth. Please convert to .docx or use a different tool.`);
    return null;
  }
  
  // PowerPoint - slides are XML inside a zip; text lives in <a:t> runs, grouped by <a:p> paragraph
  if (lowerExt === '.pptx' || lowerExt === '.ppsx') {
    try {
      const zip = await JSZip.loadAsync(data);
      const slideNumber = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);
      const xmlText = (xml: string) =>
        xml
          .split(/<\/a:p>/)
          .map((para) => [...para.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(''))
          .map((line) => line
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim())
          .filter(Boolean)
          .join('\n');

      const slides = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => slideNumber(a) - slideNumber(b));

      const parts: string[] = [];
      for (const name of slides) {
        const n = slideNumber(name);
        let text = xmlText(await zip.file(name)!.async('string')).split('\n').filter((l) => !/^\d+$/.test(l)).join('\n');
        const notes = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
        if (notes) {
          // Notes slides also contain the slide-number placeholder; drop bare numbers
          const notesText = xmlText(await notes.async('string')).split('\n').filter((l) => !/^\d+$/.test(l)).join('\n');
          if (notesText) text += `\n[Notes] ${notesText}`;
        }
        parts.push(`--- Slide ${n} ---\n${text || '(no text — likely a diagram or image)'}`);
      }
      return parts.length ? parts.join('\n\n') : null;
    } catch (error: any) {
      console.error(`[PPTX] Error extracting text: ${error?.message || error}`);
      return null;
    }
  }

  // PDF files - extract text with pdf-parse
  if (lowerExt === '.pdf') {
    try {
      const require = createRequire(import.meta.url);
      const pdfParse = require('pdf-parse');
      
      // Suppress stderr warnings from pdf-parse (like "TT: undefined function")
      const originalStderr = process.stderr.write;
      const stderrBuffer: string[] = [];
      process.stderr.write = function(chunk: any, encoding?: any, callback?: any) {
        const message = chunk?.toString() || '';
        // Filter out harmless pdf-parse warnings
        if (message.includes('TT: undefined function') || 
            message.includes('Warning:') && message.includes('pdf-parse')) {
          return true; // Suppress these warnings
        }
        stderrBuffer.push(message);
        return originalStderr.call(process.stderr, chunk, encoding, callback);
      };
      
      try {
        const pdfData = await pdfParse(data);
        // Restore stderr
        process.stderr.write = originalStderr;
        return pdfData?.text || null;
      } catch (parseError: any) {
        // Restore stderr
        process.stderr.write = originalStderr;
        throw parseError;
      }
    } catch (error: any) {
      console.error(`[PDF] Error parsing PDF: ${error?.message || error}`);
      return null;
    }
  }
  
  // For binary files, return null (could add base64 option later)
  return null;
}

// ---- Avenue file downloads (organized into the course library) ----

interface TocNode {
  Title: string;
  Topics?: { Title: string; Url?: string }[];
  Modules?: TocNode[];
}

const TOC_TTL_MS = 10 * 60 * 1000;
const tocCache = new Map<number, { at: number; modules: TocNode[] }>();
let enrollmentNames: Map<number, string> | null = null;

/** Course name/code for an org unit id, from enrollments (fetched once per process). */
async function courseNameFor(orgUnitId: number): Promise<string | null> {
  if (!enrollmentNames) {
    const { Items } = await client.getMyEnrollments() as { Items: { OrgUnit: { Id: number; Name: string; Code?: string } }[] };
    enrollmentNames = new Map(Items.map((i) => [i.OrgUnit.Id, `${i.OrgUnit.Code ?? ''} ${i.OrgUnit.Name}`]));
  }
  return enrollmentNames.get(orgUnitId) ?? null;
}

/** Find which module (folder path) and topic title a file URL belongs to in the course's content. */
async function locateTopic(orgUnitId: number, fileUrl: string): Promise<{ modulePath: string[]; title: string } | null> {
  let cached = tocCache.get(orgUnitId);
  if (!cached || Date.now() - cached.at > TOC_TTL_MS) {
    const toc = await client.getContentToc(orgUnitId) as { Modules: TocNode[] };
    cached = { at: Date.now(), modules: toc.Modules || [] };
    tocCache.set(orgUnitId, cached);
  }
  const target = decodeURIComponent(new URL(fileUrl).pathname);
  const search = (modules: TocNode[], trail: string[]): { modulePath: string[]; title: string } | null => {
    for (const mod of modules) {
      const here = [...trail, mod.Title];
      for (const topic of mod.Topics || []) {
        if (topic.Url && decodeURIComponent(topic.Url.split('?')[0]) === target) return { modulePath: here, title: topic.Title };
      }
      const found = search(mod.Modules || [], here);
      if (found) return found;
    }
    return null;
  };
  return search(cached.modules, []);
}

/** GET a D2L file with the session cookies; retries once with a fresh login if the session expired. */
async function fetchD2L(url: string, headers: Record<string, string>): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let target = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(target, { headers: { ...headers, Cookie: await getD2LCookies() }, redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) break;
      target = new URL(location, target).toString();
    }
    if (res && new URL(target).pathname.startsWith('/d2l/login')) {
      console.error('[DOWNLOAD] D2L session expired, logging in again');
      clearTokenCache();
      continue;
    }
    if (res && (res.ok || res.status === 304)) return res;
    throw new Error(`Avenue returned ${res?.status} for ${url}`);
  }
  throw new Error('Avenue session expired and re-login failed');
}

export async function downloadFile(url: string, savePath?: string, refresh?: boolean) {
  const fullUrl = new URL(url.startsWith('http') ? url : `https://${D2L_HOST}${url}`).toString();
  const urlPath = decodeURIComponent(new URL(fullUrl).pathname);
  const urlFilename = urlPath.split('/').filter(Boolean).pop() || 'download';

  // /content/enforced/781481-SFWRENG_3O03_deza_1_2269/file.pdf, or an org unit id elsewhere in the path
  const enforced = urlPath.match(/\/content\/enforced\/(\d+)-([^/]+)\//);
  const orgUnitId = enforced ? Number(enforced[1]) : Number(urlPath.match(/\/(\d{5,})(?:\/|$)/)?.[1]) || null;
  const codeHint = enforced?.[2] ?? null;

  // Course and module lookups hit the API, so only resolve the folder on a first download
  const resolveTarget = async (): Promise<string> => {
    let course = codeHint ? findCourse(codeHint) : null;
    if (!course && orgUnitId) {
      const name = await courseNameFor(orgUnitId).catch(() => null);
      if (name) course = findCourse(name);
    }

    // Mirror Avenue's module structure and use the topic's title as the filename
    const location = orgUnitId ? await locateTopic(orgUnitId, fullUrl).catch(() => null) : null;
    const ext = path.extname(urlFilename);
    const filename = location && location.title.trim()
      ? sanitizeName(location.title.toLowerCase().endsWith(ext.toLowerCase()) ? location.title : `${location.title}${ext}`)
      : sanitizeName(urlFilename);
    return path.join(
      courseDir(course, codeHint || String(orgUnitId ?? 'Other')),
      'Avenue',
      ...(location?.modulePath ?? []).map(sanitizeName),
      filename
    );
  };

  const result = await getFile({
    url: fullUrl,
    targetPath: resolveTarget,
    fetch: (headers) => fetchD2L(fullUrl, headers),
    canRevalidate: hasActiveSession,
    refresh,
  });

  // Optional extra copy somewhere specific; the library copy stays the source of truth
  let finalPath = result.path;
  if (savePath) {
    finalPath = fs.existsSync(savePath) && fs.statSync(savePath).isDirectory()
      ? path.join(savePath, path.basename(result.path))
      : savePath;
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.copyFileSync(result.path, finalPath);
  }

  return {
    path: finalPath,
    filename: path.basename(finalPath),
    size: result.size,
    contentType: result.contentType || 'application/octet-stream',
    status: result.status,
    note: result.note,
    content: await readTextCached(result.path, extractContent),
  };
}

/**
 * Resolve a user-provided path or filename to an absolute file path.
 * Mirrors the logic used by readFile so download/read/delete all agree.
 */
function resolveFilePath(filePath: string): string {
  let finalPath = filePath;

  // If path doesn't exist and doesn't start with /, try Downloads folder
  if (!fs.existsSync(filePath) && !path.isAbsolute(filePath)) {
    const downloadsPath = path.join(os.homedir(), "Downloads", filePath);
    if (fs.existsSync(downloadsPath)) {
      finalPath = downloadsPath;
    }
  }

  // If still not found, try to find by filename in Downloads
  if (!fs.existsSync(finalPath)) {
    const downloadsDir = path.join(os.homedir(), "Downloads");
    if (fs.existsSync(downloadsDir)) {
      try {
        const files = fs.readdirSync(downloadsDir);
        const matchingFile = files.find(
          (f) =>
            f.toLowerCase().includes(filePath.toLowerCase()) || f === filePath
        );
        if (matchingFile) {
          finalPath = path.join(downloadsDir, matchingFile);
        }
      } catch {
        // Ignore readdir errors
      }
    }
  }

  // Check if file exists
  if (!fs.existsSync(finalPath)) {
    throw new Error(
      `File not found: ${filePath}. Searched in Downloads folder: ${path.join(
        os.homedir(),
        "Downloads"
      )}`
    );
  }

  // Check if it's a directory
  const stats = fs.statSync(finalPath);
  if (stats.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${finalPath}`);
  }

  return finalPath;
}

/**
 * Read a file from disk and extract its text content
 * Supports PDF, DOCX, TXT, and other text-based formats
 */
export async function readFile(filePath: string): Promise<{
  path: string;
  filename: string;
  size: number;
  contentType: string;
  content: string | null;
  exists: boolean;
}> {
  const finalPath = resolveFilePath(filePath);

  // Read file
  const data = fs.readFileSync(finalPath);
  const ext = path.extname(finalPath);

  // Determine content type
  const extToMime: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".json": "application/json",
    ".csv": "text/csv",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
  };

  const contentType = extToMime[ext.toLowerCase()] || "application/octet-stream";

  // Extract text content
  const textContent = await extractContent(data, ext);

  return {
    path: finalPath,
    filename: path.basename(finalPath),
    size: data.length,
    contentType,
    content: textContent,
    exists: true,
  };
}

/**
 * Delete a file from disk.
 * Uses the same resolution rules as readFile (Downloads search, etc).
 */
export async function deleteFile(filePath: string): Promise<{
  path: string;
  filename: string;
  deleted: boolean;
}> {
  const finalPath = resolveFilePath(filePath);

  try {
    fs.unlinkSync(finalPath);
    return {
      path: finalPath,
      filename: path.basename(finalPath),
      deleted: true,
    };
  } catch (error: any) {
    console.error(
      `[FILE] Failed to delete file ${finalPath}: ${error?.message || error}`
    );
    throw new Error(`Failed to delete file: ${finalPath}`);
  }
}
