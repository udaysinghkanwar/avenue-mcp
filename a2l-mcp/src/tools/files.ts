import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getAuthenticatedContext } from '../auth.js';
import mammoth from 'mammoth';

const D2L_HOST = process.env.D2L_HOST || 'learn.ul.ie';

// Extract text content from various file types
async function extractContent(data: Buffer, ext: string): Promise<string | null> {
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

export async function downloadFile(url: string, savePath?: string) {
  // Ensure full URL
  const fullUrl = url.startsWith('http') ? url : `https://${D2L_HOST}${url}`;
  
  // Extract filename from URL
  const urlPath = new URL(fullUrl).pathname;
  const pathParts = urlPath.split('/');
  const urlFilename = decodeURIComponent(pathParts[pathParts.length - 1] || 'download');

  // Get authenticated browser context (handles SSO login if needed)
  const browser = await getAuthenticatedContext();

  try {
    const page = await browser.newPage();

    const downloadsDir = savePath && fs.existsSync(savePath) && fs.statSync(savePath).isDirectory()
      ? savePath
      : path.join(os.homedir(), 'Downloads');

    const extToMime: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.zip': 'application/zip',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
    };

    const saveDownload = async (download: any) => {
      const suggestedFilename = download.suggestedFilename() || urlFilename;
      let finalPath = savePath && fs.existsSync(savePath) && !fs.statSync(savePath).isDirectory()
        ? savePath
        : path.join(downloadsDir, suggestedFilename);

      let counter = 1;
      const ext = path.extname(finalPath);
      const base = path.basename(finalPath, ext);
      const dirPath = path.dirname(finalPath);
      while (fs.existsSync(finalPath)) {
        finalPath = path.join(dirPath, `${base} (${counter})${ext}`);
        counter++;
      }

      await download.saveAs(finalPath);
      console.error(`[DOWNLOAD] File saved: ${finalPath}`);

      const data = fs.readFileSync(finalPath);
      const contentType = extToMime[ext.toLowerCase()] || 'application/octet-stream';
      const textContent = await extractContent(data, ext);

      return {
        path: finalPath,
        filename: path.basename(finalPath),
        size: data.length,
        contentType,
        content: textContent,
      };
    };

    // Listen for download event BEFORE navigation so we catch enforced downloads
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);

    console.error(`[DOWNLOAD] Navigating to: ${fullUrl}`);
    const response = await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check if navigation itself triggered a download
    const earlyDownload = await Promise.race([
      downloadPromise,
      page.waitForTimeout(3000).then(() => null),
    ]);

    if (earlyDownload) {
      console.error(`[DOWNLOAD] Navigation triggered download directly`);
      return await saveDownload(earlyDownload);
    }

    // Strategy 1: Look for download button/link on the page
    const downloadSelectors = [
      'a[download]',
      'a:has-text("Download")',
      'button:has-text("Download")',
      'a[href*="download"]',
      'a[href*="ViewFile"]',
      'a[href*="FileDownload"]',
      '[data-download]',
    ];

    const clickDownloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);

    let clicked = false;
    for (const selector of downloadSelectors) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible({ timeout: 2000 })) {
          console.error(`[DOWNLOAD] Found download element: ${selector}`);
          await element.click();
          clicked = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (clicked) {
      const download = await clickDownloadPromise;
      if (download) {
        return await saveDownload(download);
      }
    }

    // Strategy 2: Direct HTTP fetch (for non-HTML file responses)
    console.error(`[DOWNLOAD] Trying direct HTTP fetch...`);
    const directResponse = await page.request.get(fullUrl);
    const responseContentType = directResponse.headers()['content-type'] || '';

    if (!responseContentType.includes('text/html') && directResponse.ok()) {
      console.error(`[DOWNLOAD] Direct file download (${responseContentType})`);
      const data = await directResponse.body();

      const contentDisposition = directResponse.headers()['content-disposition'] || '';
      let filename = urlFilename;
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (filenameMatch) {
        filename = filenameMatch[1].replace(/['"]/g, '');
      }

      let finalPath = savePath && fs.existsSync(savePath) && !fs.statSync(savePath).isDirectory()
        ? savePath
        : path.join(downloadsDir, filename);

      let counter = 1;
      const ext = path.extname(finalPath);
      const base = path.basename(finalPath, ext);
      const dirPath = path.dirname(finalPath);
      while (fs.existsSync(finalPath)) {
        finalPath = path.join(dirPath, `${base} (${counter})${ext}`);
        counter++;
      }

      fs.writeFileSync(finalPath, data);
      console.error(`[DOWNLOAD] File saved: ${finalPath} (${(data.length / 1024).toFixed(1)} KB)`);

      const finalContentType = responseContentType.includes('octet-stream')
        ? (extToMime[ext.toLowerCase()] || responseContentType)
        : responseContentType;

      const textContent = await extractContent(data, ext);

      return {
        path: finalPath,
        filename: path.basename(finalPath),
        size: data.length,
        contentType: finalContentType,
        content: textContent,
      };
    }

    throw new Error('Could not trigger file download. The page may use enforced content that requires manual download.');

  } finally {
    await browser.close();
  }
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
