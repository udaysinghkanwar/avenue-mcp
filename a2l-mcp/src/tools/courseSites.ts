import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { extractContent } from './files.js';
import { CONFIG_PATH, CourseWebsite, ResolvedCourse, courseDir, loadConfig, requireCourse, sanitizeName } from '../courses.js';
import { getFile, readTextCached } from '../library.js';

/**
 * Tools for course websites hosted outside Avenue (e.g. instructor pages on
 * cas.mcmaster.ca), configured under "website" in courses.json. Pages are fetched
 * live; files are kept in the course library under "<course folder>/Course Website/".
 */

function requireWebsite(course: string): ResolvedCourse & { website: CourseWebsite } {
  const resolved = requireCourse(course);
  if (!resolved.website?.pages?.length) {
    throw new Error(`${resolved.code} has no website configured (add "website" to it in ${CONFIG_PATH})`);
  }
  return resolved as ResolvedCourse & { website: CourseWebsite };
}

// Only send credentials to the hosts the site was configured with
async function siteFetch(site: CourseWebsite, url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const host = new URL(url).host;
  const headers: Record<string, string> = { ...extraHeaders };
  if (site.auth && site.pages.some((p) => new URL(p).host === host)) {
    const token = Buffer.from(`${site.auth.username}:${site.auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 304) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  return res;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h\d|li|tr|table|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function extractLinks(html: string, baseUrl: string): { text: string; url: string }[] {
  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: string;
    try { url = new URL(decodeEntities(m[1]), baseUrl).toString(); } catch { continue; }
    if (url.endsWith('.css') || seen.has(url)) continue;
    seen.add(url);
    links.push({ text: htmlToText(m[2]).replace(/\s+/g, ' ') || '(no text)', url });
  }
  return links;
}

export const courseSiteTools = {
  get_course_site: {
    description: `Read a course's external website (instructor-hosted pages outside Avenue, e.g. cas.mcmaster.ca) live. Returns each page's text (instructor, TAs, office hours, schedule, midterm dates, notices) plus a list of every linked file (lecture notes, assignments, solutions, midterm info) with its URL. Call with no course to list which courses have websites configured. Use read_course_site_file to read a linked file. Check this in addition to Avenue for courses that have one.`,
    schema: {
      course: z.string().optional().describe('Course code, e.g. "3BB4" or "SFWRENG 3MX3". Omit to list configured sites.'),
    },
    handler: async ({ course }: { course?: string }): Promise<string> => {
      if (!course) {
        const { courses } = loadConfig();
        return JSON.stringify(
          Object.entries(courses).filter(([, c]) => c.website).map(([code, c]) => ({ code, name: c.name, pages: c.website!.pages })),
          null, 2
        );
      }
      const { code, name, website: site } = requireWebsite(course);
      const sections = await Promise.all(site.pages.map(async (url) => {
        try {
          const html = await (await siteFetch(site, url)).text();
          const links = extractLinks(html, url)
            .filter((l) => !site.pages.includes(l.url))
            .map((l) => `- ${l.text}: ${l.url}`);
          return `## ${url}\n\n${htmlToText(html)}\n\n### Links on this page\n${links.join('\n') || '(none)'}`;
        } catch (error) {
          return `## ${url}\n\nFailed to load: ${error instanceof Error ? error.message : String(error)}`;
        }
      }));
      return `# ${code}${name ? ` — ${name}` : ''}\n\n${sections.join('\n\n')}`;
    },
  },

  read_course_site_file: {
    description: `Get a file linked from a course's external website (URLs from get_course_site) and return its text. Supports PDF, DOCX, HTML and plain text. Files are saved once into the course's folder (<course>/Course Website/) and served from there afterwards, so asking again is instant and doesn't re-download; the returned path can be shared with the user. Set refresh=true only if the user says the file was updated.`,
    schema: {
      course: z.string().describe('Course code the file belongs to, e.g. "3MX3" (used for folder and login)'),
      url: z.string().describe('Full URL of the file, as listed by get_course_site'),
      refresh: z.boolean().optional().describe('Force a check for a newer version on the website'),
    },
    handler: async ({ course, url, refresh }: { course: string; url: string; refresh?: boolean }): Promise<string> => {
      const resolved = requireWebsite(course);
      const canonical = new URL(url).toString();
      const filename = sanitizeName(decodeURIComponent(new URL(canonical).pathname.split('/').filter(Boolean).pop() || 'index.html'));
      const result = await getFile({
        url: canonical,
        targetPath: path.join(courseDir(resolved, resolved.code), 'Course Website', filename),
        fetch: (headers) => siteFetch(resolved.website, canonical, headers),
        canRevalidate: () => true,
        refresh,
      });

      let header = `File: ${path.basename(result.path)}\nPath: ${result.path}\nStatus: ${result.status}\nSize: ${(result.size / 1024).toFixed(1)} KB`;
      if (result.note) header += `\nNote: ${result.note}`;

      const text = result.contentType?.includes('text/html') || /\.html?$/i.test(result.path)
        ? htmlToText(fs.readFileSync(result.path, 'utf8'))
        : await readTextCached(result.path, extractContent);
      if (!text?.trim()) {
        return `${header}\n\nNo text could be extracted (the file may be scanned images or a binary format).`;
      }
      return `${header}\n\n--- File Content ---\n${text}`;
    },
  },
};
