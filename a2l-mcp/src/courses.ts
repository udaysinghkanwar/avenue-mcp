import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * Per-course configuration from courses.json (gitignored; it may hold website passwords):
 *
 * {
 *   "rootDir": "/Users/me/Year 3",
 *   "courses": {
 *     "3BB4": {
 *       "name": "SFWRENG 3BB4: ...",
 *       "folder": "Concurrent Systems",
 *       "website": { "pages": ["https://..."], "auth": { "username": "...", "password": "..." } }
 *     }
 *   }
 * }
 *
 * Keys are course codes ("3BB4"), matched against Avenue course codes like SFWRENG_3BB4_....
 */

export interface CourseWebsite {
  pages: string[];
  auth?: { username: string; password: string };
}

export interface CourseConfig {
  name?: string;
  folder?: string;
  website?: CourseWebsite;
}

interface CoursesFile {
  rootDir?: string;
  courses: Record<string, CourseConfig>;
}

export interface ResolvedCourse extends CourseConfig {
  code: string;
}

export const CONFIG_PATH = process.env.COURSES_FILE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'courses.json');

// Files for courses not in courses.json still get organized, just outside rootDir
const FALLBACK_DIR = path.join(os.homedir(), 'Downloads', 'Avenue');

export function loadConfig(): CoursesFile {
  if (!fs.existsSync(CONFIG_PATH)) return { courses: {} };
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as CoursesFile;
  return { rootDir: parsed.rootDir, courses: parsed.courses || {} };
}

/** Find a configured course whose code appears in `text` (e.g. "SFWRENG 3MX3", "781481-SFWRENG_3O03_deza"). */
export function findCourse(text: string): ResolvedCourse | null {
  const haystack = text.toUpperCase();
  for (const [code, course] of Object.entries(loadConfig().courses)) {
    // Code must not be part of a longer alphanumeric run, so "3DB3" doesn't match "13DB34"
    const re = new RegExp(`(^|[^A-Z0-9])${code.toUpperCase()}([^A-Z0-9]|$)`);
    if (re.test(haystack)) return { code, ...course };
  }
  return null;
}

export function requireCourse(text: string): ResolvedCourse {
  const course = findCourse(text);
  if (!course) {
    const known = Object.keys(loadConfig().courses).join(', ') || 'none';
    throw new Error(`No course configured matching "${text}". Configured: ${known} (edit ${CONFIG_PATH})`);
  }
  return course;
}

/** Folder that holds a course's files, e.g. "~/Year 3/Concurrent Systems". */
export function courseDir(course: ResolvedCourse | null, fallbackName: string): string {
  const { rootDir } = loadConfig();
  if (course && rootDir) return path.join(rootDir, sanitizeName(course.folder || course.code));
  return path.join(FALLBACK_DIR, sanitizeName(course?.code || fallbackName));
}

/** Make a string safe to use as a single file or folder name. */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return cleaned || 'untitled';
}
