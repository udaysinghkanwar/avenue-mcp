import "dotenv/config";
import { chromium, BrowserContext, Page } from "playwright";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

const SESSION_PATH = process.env.SESSION_DIR || join(homedir(), ".d2l-session");

const D2L_HOST = process.env.D2L_HOST || "learn.ul.ie";
const D2L_SSO_LOGIN_URL = process.env.D2L_SSO_LOGIN_URL;
const D2L_USERNAME = process.env.D2L_USERNAME;
const D2L_PASSWORD = process.env.D2L_PASSWORD;
const REMOTE_DEBUG = process.env.REMOTE_DEBUG === "true";
const HOME_URL = `https://${D2L_HOST}/d2l/home`;
const LOGIN_URL = `https://${D2L_HOST}`;

interface TokenCache {
  token: string;
  expiresAt: number;
  // D2L session cookies from the same login; /content/enforced/ files need these, not the Bearer token
  cookies: string;
}

let tokenCache: TokenCache = { token: "", expiresAt: 0, cookies: "" };

async function d2lCookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(LOGIN_URL);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function isLoginPage(url: string): boolean {
  return (
    url.includes("login") ||
    url.includes("microsoftonline") ||
    url.includes("sso") ||
    url.includes("adfs")
  );
}

export async function getToken(): Promise<string> {
  const authStartTime = Date.now();

  // Return cached token if still valid (with 1 hour buffer for safety)
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 3600000) {
    const cacheTime = Date.now() - authStartTime;
    const timeUntilExpiry = tokenCache.expiresAt - Date.now();
    console.error(
      `[AUTH] Token cache hit (${cacheTime}ms, expires in ${Math.round(
        timeUntilExpiry / 1000
      )}s)`
    );
    return tokenCache.token;
  }

  // Concurrent callers share one refresh: each refresh launches a browser on the
  // same persistent profile, and Chromium allows only one process per profile.
  if (!refreshInFlight) {
    refreshInFlight = refreshToken().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

let refreshInFlight: Promise<string> | null = null;

/**
 * Launch the persistent browser profile, waiting if another process (e.g. a second
 * MCP server instance) currently holds it.
 */
async function launchProfile(options: Parameters<typeof chromium.launchPersistentContext>[1]): Promise<BrowserContext> {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      return await chromium.launchPersistentContext(SESSION_PATH, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ProcessSingleton") || Date.now() > deadline) throw error;
      console.error("[AUTH] Browser profile in use by another process, retrying...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function refreshToken(): Promise<string> {
  const authStartTime = Date.now();
  console.error(`[AUTH] Token cache miss - refreshing token`);
  const hasExistingSession = existsSync(SESSION_PATH);
  console.error(
    `[AUTH] Existing session file: ${hasExistingSession ? "yes" : "no"}`
  );

  // Configure browser args for remote debugging if enabled
  const browserArgs: string[] = [];
  if (REMOTE_DEBUG) {
    browserArgs.push(
      '--remote-debugging-port=9222',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    );
    console.error('[AUTH] Remote debugging enabled on port 9222');
    console.error('[AUTH] Connect via: chrome://inspect after setting up SSH tunnel');
    console.error('[AUTH] SSH tunnel: ssh -L 9222:localhost:9222 ec2-user@your-ip');
  }

  const browserStartTime = Date.now();
  const isMac = process.platform === "darwin";
  const isProduction = process.env.NODE_ENV === "production" || (!isMac && !process.env.DISPLAY);
  const headless = isProduction || (hasExistingSession && !REMOTE_DEBUG);
  let context = await launchProfile({
    headless,
    viewport: { width: 1280, height: 720 },
    args: browserArgs.length > 0 ? browserArgs : undefined,
  });
  const browserTime = Date.now() - browserStartTime;
  console.error(
    `[AUTH] Browser launched (headless: ${headless}, ${browserTime}ms)`
  );

  try {
    const captureStartTime = Date.now();
    const result = await captureToken(context, hasExistingSession);
    const captureTime = Date.now() - captureStartTime;
    console.error(`[AUTH] Token captured (${captureTime}ms)`);

    // If we need to login and were running headless, restart with headed browser
    if (result.needsLogin && hasExistingSession) {
      await context.close();
      console.error("[AUTH] Session expired, opening browser for login...");
      const retryBrowserStartTime = Date.now();
      context = await launchProfile({
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: browserArgs.length > 0 ? browserArgs : undefined,
      });
      const retryBrowserTime = Date.now() - retryBrowserStartTime;
      console.error(
        `[AUTH] Browser relaunched (headed, ${retryBrowserTime}ms)`
      );

      const retryCaptureStartTime = Date.now();
      const retryResult = await captureToken(context, false);
      const retryCaptureTime = Date.now() - retryCaptureStartTime;
      console.error(`[AUTH] Token captured on retry (${retryCaptureTime}ms)`);

      tokenCache = {
        token: retryResult.token,
        expiresAt: Date.now() + 82800000, // 23 hours
        cookies: await d2lCookieHeader(context),
      };
      const totalTime = Date.now() - authStartTime;
      console.error(`[AUTH] Token refresh completed (${totalTime}ms)`);
      return retryResult.token;
    }

    tokenCache = {
      token: result.token,
      expiresAt: Date.now() + 82800000, // 23 hours
      cookies: await d2lCookieHeader(context),
    };
    const totalTime = Date.now() - authStartTime;
    console.error(`[AUTH] Token refresh completed (${totalTime}ms)`);
    return result.token;
  } finally {
    const closeStartTime = Date.now();
    await context.close();
    const closeTime = Date.now() - closeStartTime;
    console.error(`[AUTH] Browser context closed (${closeTime}ms)`);
  }
}

async function performMicrosoftSSOLogin(page: Page): Promise<void> {
  if (!D2L_USERNAME || !D2L_PASSWORD) throw new Error("No credentials configured");

  // Step 1: Fill email
  console.error(`[AUTH] Microsoft SSO: entering email...`);
  const emailField = page.locator('input#i0116, input[name="loginfmt"], input[type="email"]').first();
  await emailField.waitFor({ state: "visible", timeout: 10000 });
  await emailField.fill(D2L_USERNAME);

  // Step 2: Click Next
  const nextButton = page.locator('input#idSIButton9, input[type="submit"]').first();
  await nextButton.click();
  await page.waitForTimeout(3000);

  // Step 3: Fill password (appears after Next)
  console.error(`[AUTH] Microsoft SSO: entering password...`);
  const passwordField = page.locator('input#i0118, input[name="passwd"], input[type="password"]').first();
  await passwordField.waitFor({ state: "visible", timeout: 10000 });
  await passwordField.fill(D2L_PASSWORD);

  // Step 4: Click Sign In
  const signInButton = page.locator('input#idSIButton9, input[type="submit"]').first();
  await signInButton.click();
  console.error(`[AUTH] Microsoft SSO: submitted credentials, waiting...`);

  // Step 5: Handle "Stay signed in?" prompt if it appears
  try {
    const staySignedIn = page.locator('input#idSIButton9, input#idBtn_Back, button:has-text("Yes"), button:has-text("No")').first();
    await staySignedIn.waitFor({ state: "visible", timeout: 5000 });
    const yesButton = page.locator('input#idSIButton9, button:has-text("Yes")').first();
    if (await yesButton.isVisible({ timeout: 1000 })) {
      console.error(`[AUTH] Microsoft SSO: clicking "Yes" on stay signed in prompt`);
      await yesButton.click();
    }
  } catch {
    // No "stay signed in" prompt, that's fine
  }

  // Wait for redirect away from Microsoft
  console.error(`[AUTH] Microsoft SSO: waiting for redirect...`);
  await page.waitForURL((url) => !url.toString().includes("microsoftonline"), {
    timeout: 30000,
  });
  await page.waitForLoadState("networkidle");
  console.error(`[AUTH] Microsoft SSO: completed, now at ${page.url()}`);
}

async function performLogin(page: Page, currentUrl: string, quickCheck: boolean): Promise<void> {
  if (!D2L_USERNAME || !D2L_PASSWORD) throw new Error("No credentials configured");

  console.error(`[AUTH] Attempting login from ${currentUrl}`);

  // Check if there are visible form fields on the current page
  const hasVisibleInput = await page.locator('input[type="text"], input[type="email"], input[type="password"]')
    .first().isVisible({ timeout: 2000 }).catch(() => false);

  // Portal page with no form fields — need to go through SSO
  if (!hasVisibleInput && currentUrl.includes('/d2l/login')) {
    // Use configured SSO login URL, or try to find one on the page
    let ssoUrl = D2L_SSO_LOGIN_URL;

    if (!ssoUrl) {
      // Look for an SSO link on the portal page (e.g. McMaster's "Avenue to Learn" link)
      const ssoLink = page.locator('a[href*="avenue.mcmaster.ca"], a:has-text("Avenue to Learn"), a:has-text("Login with Office 365")').first();
      if (await ssoLink.isVisible({ timeout: 2000 }).catch(() => false)) {
        ssoUrl = await ssoLink.getAttribute('href') || undefined;
        console.error(`[AUTH] Found SSO link on portal: ${ssoUrl}`);
      }
    }

    if (ssoUrl) {
      console.error(`[AUTH] Navigating to SSO login: ${ssoUrl}`);
      await page.goto(ssoUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      currentUrl = page.url();
      console.error(`[AUTH] After SSO nav, URL: ${currentUrl}`);

      // If we landed on a page with a "Login with Office 365" link, click it
      const office365Link = page.locator('a:has-text("Login with Office 365"), a:has-text("Office 365")').first();
      if (await office365Link.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.error(`[AUTH] Clicking Office 365 login link...`);
        await office365Link.click();
        await page.waitForLoadState("networkidle");
        currentUrl = page.url();
        console.error(`[AUTH] After Office 365 click, URL: ${currentUrl}`);
      }
    }
  }

  // Microsoft SSO login (login.microsoftonline.com)
  if (currentUrl.includes("microsoftonline")) {
    await performMicrosoftSSOLogin(page);

    // After Microsoft SSO, navigate to D2L home to establish session there
    if (!page.url().includes(D2L_HOST)) {
      console.error(`[AUTH] Post-SSO: navigating to ${HOME_URL}`);
      await page.goto(HOME_URL, { waitUntil: "networkidle", timeout: 15000 });
      console.error(`[AUTH] Post-SSO: now at ${page.url()}`);
    }
    return;
  }

  // Direct form login (ADFS, D2L native, etc.)
  const usernameSelectors = [
    "input#userNameInput", 'input[name="UserName"]',
    'input[type="email"]', 'input[name="loginfmt"]',
    'input[name="userName"]', 'input[name="username"]',
    'input[type="text"][id*="user"]', 'input[type="text"][id*="User"]',
    "input#userName", "input#username",
    'input[placeholder*="username" i]', 'input[placeholder*="user" i]',
  ];
  const passwordSelectors = [
    "input#passwordInput", 'input[name="Password"]',
    'input[name="passwd"]', 'input[type="password"]',
    'input[name="password"]', "input#password",
  ];

  let usernameField = null;
  for (const sel of usernameSelectors) {
    try {
      const f = page.locator(sel);
      if (await f.isVisible({ timeout: 2000 })) { usernameField = f; break; }
    } catch { continue; }
  }
  if (!usernameField) throw new Error("Could not find username field");

  console.error(`[AUTH] Filling username...`);
  await usernameField.fill(D2L_USERNAME);

  // Click Next/Submit (multi-step forms)
  const nextSelectors = [
    'input[type="submit"]', 'button[type="submit"]',
    'input#idSIButton9', '#submitButton',
    'button:has-text("Next")', 'button:has-text("Log In")',
  ];
  let clicked = false;
  for (const sel of nextSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click(); clicked = true;
        await page.waitForTimeout(2000);
        break;
      }
    } catch { continue; }
  }
  if (!clicked) {
    await usernameField.press("Enter");
    await page.waitForTimeout(2000);
  }

  // Password
  let passwordField = null;
  for (const sel of passwordSelectors) {
    try {
      const f = page.locator(sel);
      if (await f.isVisible({ timeout: 3000 })) { passwordField = f; break; }
    } catch { continue; }
  }
  if (!passwordField) throw new Error("Could not find password field");

  console.error(`[AUTH] Filling password...`);
  await passwordField.fill(D2L_PASSWORD);

  // Submit
  const submitSelectors = [
    'input[type="submit"]', 'button[type="submit"]',
    'input#idSIButton9', 'button:has-text("Log in")',
    'button:has-text("Sign in")', 'form button',
  ];
  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click(); submitted = true; break;
      }
    } catch { continue; }
  }
  if (!submitted) await passwordField.press("Enter");

  console.error(`[AUTH] Waiting for login to complete...`);
  await page.waitForURL((url) => !isLoginPage(url.toString()), {
    timeout: quickCheck ? 30000 : 60000,
  });
  await page.waitForLoadState("networkidle");
  console.error(`[AUTH] Login completed, now at ${page.url()}`);
}

async function captureToken(
  context: BrowserContext,
  quickCheck: boolean
): Promise<{ token: string; needsLogin: boolean }> {
  const captureStartTime = Date.now();
  console.error(`[AUTH] Starting token capture (quickCheck: ${quickCheck})`);

  const page = await context.newPage();
  let capturedToken = "";

  // Listen for requests to capture Authorization header from any D2L API call
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/d2l/api/")) {
      const auth = request.headers()["authorization"];
      if (auth?.startsWith("Bearer ")) {
        capturedToken = auth.slice(7);
        const captureTime = Date.now() - captureStartTime;
        console.error(
          `[AUTH] Token captured from API request to ${url} (${captureTime}ms)`
        );
      }
    }
  });

  // Navigate to landing page first (some D2L instances need SSO from root)
  const navigateStartTime = Date.now();
  console.error(`[AUTH] Navigating to ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: "networkidle" });
  const navigateTime = Date.now() - navigateStartTime;
  console.error(`[AUTH] Navigation completed (${navigateTime}ms)`);

  let currentUrl = page.url();
  console.error(`[AUTH] Current URL: ${currentUrl}`);

  // Check for Office 365 / SSO button on the landing page
  if (!isLoginPage(currentUrl) && !capturedToken) {
    try {
      const office365Button = page.locator(
        'a:has-text("Login with Office 365"), a:has-text("Office 365"), button:has-text("Login with Office 365"), button:has-text("Office 365")'
      );
      if (await office365Button.first().isVisible({ timeout: 3000 })) {
        console.error("[AUTH] Found Office 365 login button, clicking...");
        await office365Button.first().click();
        await page.waitForLoadState("networkidle");
        currentUrl = page.url();
        console.error(`[AUTH] After SSO click, URL: ${currentUrl}`);
      }
    } catch {
      console.error("[AUTH] No Office 365 button found, continuing...");
    }
  }

  const shouldLogin = isLoginPage(currentUrl);
  console.error(`[AUTH] Is login page: ${shouldLogin}`);

  if (shouldLogin) {
    console.error(`[AUTH] Login required`);
    // If username and password are provided via env vars, use them for login
    if (D2L_USERNAME && D2L_PASSWORD) {
      console.error(`[AUTH] Attempting automated login with credentials`);
      console.error(`[AUTH] Username configured: ${D2L_USERNAME ? 'yes' : 'no'}`);
      console.error(`[AUTH] Password configured: ${D2L_PASSWORD ? 'yes (hidden)' : 'no'}`);
      try {
        await performLogin(page, currentUrl, quickCheck);
      } catch (error) {
        console.error(`[AUTH] Login failed: ${error instanceof Error ? error.message : String(error)}`);
        if (quickCheck) {
          await page.close();
          return { token: "", needsLogin: true };
        }
      }
    } else if (D2L_SSO_LOGIN_URL) {
      // No credentials: go through the SSO entry point so a saved Microsoft
      // session (persistent profile cookies) can log in without user input.
      console.error(`[AUTH] Navigating to SSO login: ${D2L_SSO_LOGIN_URL}`);
      try {
        await page.goto(D2L_SSO_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForURL((url) => url.toString().includes(D2L_HOST) && !isLoginPage(url.toString()), {
          timeout: quickCheck ? 15000 : 120000,
        });
        console.error(`[AUTH] SSO login completed, now at ${page.url()}`);
      } catch {
        if (quickCheck && !capturedToken) {
          await page.close();
          return { token: "", needsLogin: true };
        }
      }
    } else {
      // No credentials provided, try SSO button
      try {
        const ssoButton = page.locator(
          'button.d2l-button-sso-1, button:has-text("Student & Staff Login")'
        );
        if (await ssoButton.isVisible({ timeout: 2000 })) {
          await ssoButton.click();
          // Wait for SSO redirect and completion
          await page.waitForURL((url) => !isLoginPage(url.toString()), {
            timeout: quickCheck ? 15000 : 60000,
          });
          await page.waitForLoadState("networkidle");
        }
      } catch {
        // SSO auto-login failed (needs user interaction)
        if (quickCheck) {
          await page.close();
          return { token: "", needsLogin: true };
        }
      }
    }
  }

  // Navigate to /d2l/home to trigger authenticated API calls for token capture
  if (!capturedToken && !isLoginPage(page.url())) {
    console.error(`[AUTH] Navigating to ${HOME_URL} to trigger API calls`);
    // D2L home keeps polling, so "networkidle" can time out; the loop below waits for the token
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
    console.error(`[AUTH] Now at: ${page.url()}`);
  }

  // Wait for token capture
  const maxWait = quickCheck ? 10000 : 120000;
  const waitStartTime = Date.now();
  console.error(`[AUTH] Waiting for token capture (max wait: ${maxWait}ms)`);

  while (Date.now() - waitStartTime < maxWait) {
    currentUrl = page.url();

    if (!isLoginPage(currentUrl)) {
      if (!capturedToken) {
        console.error(
          `[AUTH] Token not captured yet, waiting and scrolling...`
        );
        await page.waitForTimeout(2000);
        // May throw if the page navigates mid-call (e.g. SSO redirects)
        await page.evaluate(() => window.scrollBy(0, 100)).catch(() => {});
        await page.waitForTimeout(1000);
      }

      if (capturedToken) {
        const waitTime = Date.now() - waitStartTime;
        console.error(`[AUTH] Token captured after waiting (${waitTime}ms)`);
        break;
      }
    } else if (!quickCheck) {
      // Wait for user to login
      await page.waitForTimeout(2000);
    } else {
      break;
    }
  }

  const closePageStartTime = Date.now();
  await page.close();
  const closePageTime = Date.now() - closePageStartTime;
  console.error(`[AUTH] Page closed (${closePageTime}ms)`);

  if (!capturedToken) {
    const totalTime = Date.now() - captureStartTime;
    if (quickCheck) {
      console.error(
        `[AUTH] Token capture failed (quickCheck mode, ${totalTime}ms) - needs login`
      );
      return { token: "", needsLogin: true };
    }
    console.error(`[AUTH] Token capture failed (${totalTime}ms)`);
    throw new Error(
      "Failed to capture authentication token. Please try again."
    );
  }

  const totalTime = Date.now() - captureStartTime;
  console.error(`[AUTH] Token capture successful (${totalTime}ms)`);
  return { token: capturedToken, needsLogin: false };
}

export async function refreshTokenIfNeeded(): Promise<string> {
  return getToken();
}

export function clearTokenCache(): void {
  tokenCache = { token: "", expiresAt: 0, cookies: "" };
}

/** Cookie header for fetching D2L files directly (logs in if needed). */
export async function getD2LCookies(): Promise<string> {
  await getToken();
  return tokenCache.cookies;
}

/** True if a login is already cached, i.e. D2L requests won't open a browser. */
export function hasActiveSession(): boolean {
  return !!tokenCache.token && Date.now() < tokenCache.expiresAt - 3600000;
}

export function getTokenExpiry(): number {
  return tokenCache.expiresAt;
}

export async function getAuthenticatedContext(): Promise<BrowserContext> {
  const hasExistingSession = existsSync(SESSION_PATH);

  let context = await chromium.launchPersistentContext(SESSION_PATH, {
    headless: hasExistingSession,
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  // Go to home to check auth status
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });

  let currentUrl = page.url();
  if (isLoginPage(currentUrl)) {
    if (D2L_USERNAME && D2L_PASSWORD) {
      try {
        await performLogin(page, currentUrl, false);
      } catch (error) {
        console.error("Login failed:", error);
      }
    } else if (hasExistingSession) {
      await context.close();
      console.error("Session expired, opening browser for login...");
      context = await chromium.launchPersistentContext(SESSION_PATH, {
        headless: false,
        viewport: { width: 1280, height: 720 },
      });
      const newPage = await context.newPage();
      await newPage.goto(HOME_URL, { waitUntil: "domcontentloaded" });
      await newPage.waitForURL((url) => !isLoginPage(url.toString()), {
        timeout: 120000,
      });
      await newPage.close();
    }
  }

  await page.close();
  return context;
}
