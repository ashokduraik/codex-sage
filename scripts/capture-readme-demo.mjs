/**
 * Capture README demo stills + GIF frames from the local Vite app.
 * Run with: node scripts/capture-readme-demo.mjs
 * Requires `npm run dev`, system Chrome (Playwright channel: chrome), and ffmpeg.
 */
import { mkdir, rm, readdir, rename, stat, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'docs', 'images');
const FRAMES = join(OUT, '_frames');
const BASE = process.env.DEMO_BASE_URL || 'http://localhost:5173';
const EMAIL = process.env.DEMO_EMAIL || 'admin@localhost';
const PASSWORD = process.env.DEMO_PASSWORD || 'abc123';
const REPO_URL = process.env.DEMO_REPO_URL || 'https://github.com/octocat/Hello-World';
const VIEWPORT = { width: 1440, height: 1100 };
/** Output GIF frame rate (lower fps keeps longer holds under ~2 MB / ~20 s). */
const GIF_FPS = 5;
/** Max GIF byte size before raising palette compression. */
const GIF_MAX_BYTES = 2 * 1024 * 1024;
/** Target max playback length for the demo GIF (seconds). */
const GIF_MAX_SECONDS = 20;
/** Full-frame mean luma floor for GIF QA (0–255). */
const MIN_FRAME_LUMA = 120;
/** Projects kept after demo-tenant reset (case-insensitive). */
const KEEP_PROJECT_NAMES = new Set(['prepayment advisor', 'orion analytics', 'helios gateway']);
/** Companion projects created when missing so the list looks like a real tenant. */
const DEMO_COMPANION_PROJECTS = [
  {
    name: 'Orion Analytics',
    description: 'Real-time analytics ingestion and dashboarding.',
  },
  {
    name: 'Helios Gateway',
    description: 'API gateway and routing with auth and rate limiting.',
  },
];
/** Temporary project created during the GIF create→connect beat (removed afterward). */
const CAPTURE_FLOW_PROJECT_NAME = 'Atlas Commerce';
const API_ORIGIN = process.env.DEMO_API_ORIGIN || 'http://localhost:3000';
const API_BASE = `${API_ORIGIN}/api/v1`;

/**
 * Sleep helper.
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hold duration → number of identical frames at GIF_FPS.
 * @param {number} seconds Hold length in seconds.
 * @returns {number} Frame copy count.
 */
function framesForSeconds(seconds) {
  return Math.max(1, Math.round(seconds * GIF_FPS));
}

/** Capture-only modal backdrop opacity (product UI stays at Tailwind bg-black/80). */
const CAPTURE_OVERLAY_RGBA = 'rgb(15 23 42 / 0.28)';

/**
 * Capture-only styles: kill motion. Backdrop lightening is applied in JS because
 * Tailwind `bg-black/80` wins over stylesheet `!important` in this build.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<void>}
 */
async function injectCaptureStyles(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
}

/**
 * Lighten every open dialog overlay for this capture session only.
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<void>}
 */
async function lightenOpenDialogOverlays(page) {
  await page.evaluate((rgba) => {
    const overlays = document.querySelectorAll('[data-state="open"].fixed.inset-0, [data-state="open"][class*="inset-0"]');
    for (const node of overlays) {
      // Skip dialog content panels — only dimmers are empty fixed full-viewport layers.
      if (node.getAttribute('role') === 'dialog') continue;
      node.style.setProperty('background', rgba, 'important');
      node.style.setProperty('background-color', rgba, 'important');
      node.style.setProperty('opacity', '1', 'important');
    }
  }, CAPTURE_OVERLAY_RGBA);
}

/**
 * Login via API and return the access token for cleanup calls.
 * @param {import('@playwright/test').APIRequestContext} request Playwright request context.
 * @returns {Promise<string>} Bearer access token.
 */
async function loginForApi(request) {
  const response = await request.post(`${API_BASE}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  if (!response.ok()) {
    throw new Error(`API login failed: ${response.status()} ${await response.text()}`);
  }
  const body = await response.json();
  const token = body?.accessToken;
  if (!token) {
    throw new Error('API login response missing accessToken');
  }
  return token;
}

/**
 * Authenticated JSON helper against the local API.
 * @param {import('@playwright/test').APIRequestContext} request Request context.
 * @param {string} token Access token.
 * @param {string} method HTTP method.
 * @param {string} path Path under /api/v1.
 * @param {unknown} [body] Optional JSON body.
 * @param {Record<string, string>} [extraHeaders] Extra headers.
 * @returns {Promise<unknown>}
 */
async function apiJson(request, token, method, path, body, extraHeaders = {}) {
  const response = await request.fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    data: body,
  });
  if (response.status() === 204) {
    return undefined;
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok()) {
    throw new Error(`${method} ${path} → ${response.status()} ${text.slice(0, 300)}`);
  }
  return parsed;
}

/**
 * Soft-delete junk Atlas Commerce / capture leftovers and ensure 2–3 realistic projects remain.
 * @param {import('@playwright/test').APIRequestContext} request Request context.
 * @param {string} token Access token.
 * @returns {Promise<void>}
 */
async function resetDemoTenantProjects(request, token) {
  /** @type {{ items?: Array<{ id: string, name: string }> }} */
  const listed = /** @type {any} */ (await apiJson(request, token, 'GET', '/projects?limit=100'));
  const items = Array.isArray(listed?.items) ? listed.items : [];

  for (const project of items) {
    const name = String(project.name || '').trim();
    const keep = KEEP_PROJECT_NAMES.has(name.toLowerCase());
    if (keep) continue;
    await apiJson(request, token, 'DELETE', `/projects/${encodeURIComponent(project.id)}`);
    console.log(`Soft-deleted demo junk project: ${name}`);
  }

  /** @type {{ items?: Array<{ id: string, name: string }> }} */
  const afterDelete = /** @type {any} */ (await apiJson(request, token, 'GET', '/projects?limit=100'));
  const remaining = new Set(
    (Array.isArray(afterDelete?.items) ? afterDelete.items : []).map((p) => String(p.name || '').trim().toLowerCase()),
  );

  for (const companion of DEMO_COMPANION_PROJECTS) {
    if (remaining.has(companion.name.toLowerCase())) continue;
    await apiJson(
      request,
      token,
      'POST',
      '/projects',
      {
        name: companion.name,
        description: companion.description,
        sourceType: 'repository',
      },
      { 'Idempotency-Key': `demo-capture-${companion.name.toLowerCase().replace(/\s+/g, '-')}` },
    );
    console.log(`Created companion project: ${companion.name}`);
  }
}

/**
 * Soft-delete the temporary project created during the GIF create→connect beat.
 * @param {import('@playwright/test').APIRequestContext} request Request context.
 * @param {string} token Access token.
 * @param {string} projectName Exact project name.
 * @returns {Promise<void>}
 */
async function softDeleteProjectByName(request, token, projectName) {
  /** @type {{ items?: Array<{ id: string, name: string }> }} */
  const listed = /** @type {any} */ (await apiJson(request, token, 'GET', '/projects?limit=100'));
  const match = (Array.isArray(listed?.items) ? listed.items : []).find(
    (p) => String(p.name || '').trim() === projectName,
  );
  if (!match) return;
  await apiJson(request, token, 'DELETE', `/projects/${encodeURIComponent(match.id)}`);
  console.log(`Soft-deleted capture-flow project: ${projectName}`);
}

/**
 * Wait until a dialog is fully open and the page is idle (no fade overlay mid-flight).
 * @param {import('@playwright/test').Page} page Page.
 * @param {import('@playwright/test').Locator} dialog Dialog locator.
 * @returns {Promise<void>}
 */
async function waitForDialogIdleOpen(page, dialog) {
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await lightenOpenDialogOverlays(page);
  await sleep(250);
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * Wait until no dialog remains visible (create + connect stacks both gone).
 * @param {import('@playwright/test').Page} page Page.
 * @returns {Promise<void>}
 */
async function waitForDialogIdleClosed(page) {
  await page.waitForFunction(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    return dialogs.every((node) => {
      const style = getComputedStyle(node);
      return style.display === 'none' || style.visibility === 'hidden' || node.getAttribute('data-state') === 'closed';
    });
  }, null, { timeout: 10000 }).catch(() => {});
  await page.locator('[role="dialog"]').first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  await sleep(250);
}

/**
 * Full-frame mean luma (0–255) via ffmpeg area-scale to 1×1 gray.
 * @param {string} pngPath PNG path.
 * @returns {Promise<number>} Average luma, or 0 on failure.
 */
async function frameMeanLuma(pngPath) {
  try {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      ['-i', pngPath, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 },
    );
    return stdout?.[0] ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Drop frames below the luma floor and renumber the sequence contiguously.
 * @param {string} framesDir Frames directory.
 * @returns {Promise<{ kept: number, minLuma: number, maxLuma: number }>}
 */
async function rejectDarkFrames(framesDir) {
  const names = (await readdir(framesDir)).filter((f) => /^frame_\d+\.png$/.test(f)).sort();
  const kept = [];
  let minLuma = 255;
  let maxLuma = 0;
  for (const name of names) {
    const path = join(framesDir, name);
    const luma = await frameMeanLuma(path);
    if (luma < MIN_FRAME_LUMA) {
      console.warn(`Dropping dark frame ${name} (mean luma=${luma})`);
      await rm(path);
      continue;
    }
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
    kept.push(path);
  }
  if (kept.length === 0) {
    minLuma = 0;
    maxLuma = 0;
  }
  const staging = join(framesDir, '_kept');
  await mkdir(staging, { recursive: true });
  for (let i = 0; i < kept.length; i += 1) {
    await rename(kept[i], join(staging, `frame_${String(i).padStart(3, '0')}.png`));
  }
  for (const name of await readdir(framesDir)) {
    if (name === '_kept') continue;
    await rm(join(framesDir, name), { recursive: true, force: true });
  }
  for (const name of await readdir(staging)) {
    await rename(join(staging, name), join(framesDir, name));
  }
  await rm(staging, { recursive: true, force: true });
  return { kept: kept.length, minLuma, maxLuma };
}

/**
 * Encode GIF with palettegen/paletteuse; shrink palette if over size budget.
 * @param {string} framesDir Directory of frame_NNN.png files.
 * @param {string} gifPath Output GIF path.
 * @returns {Promise<void>}
 */
async function encodeGif(framesDir, gifPath) {
  const paletteTries = [128, 96, 64, 48];
  for (const maxColors of paletteTries) {
    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-framerate',
        String(GIF_FPS),
        '-i',
        join(framesDir, 'frame_%03d.png'),
        '-vf',
        `fps=${GIF_FPS},scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${maxColors}:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`,
        '-loop',
        '0',
        gifPath,
      ];
      const child = spawn('ffmpeg', args, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}`));
      });
    });
    const { size } = await stat(gifPath);
    console.log(`GIF ${maxColors} colors → ${(size / 1024).toFixed(0)} KiB`);
    if (size <= GIF_MAX_BYTES) return;
  }
  throw new Error(`GIF still exceeds ${GIF_MAX_BYTES} bytes after palette compression`);
}

/**
 * Capture one PNG frame.
 * @param {import('@playwright/test').Page} page Page.
 * @param {number} index Frame index.
 * @returns {Promise<void>}
 */
async function captureFrame(page, index) {
  const name = `frame_${String(index).padStart(3, '0')}.png`;
  await page.screenshot({ path: join(FRAMES, name), type: 'png', animations: 'disabled' });
}

/**
 * Hold a stable viewport for a number of identical frames.
 * @param {import('@playwright/test').Page} page Page.
 * @param {() => number} nextIndex Next frame index allocator.
 * @param {number} copies Frame copies.
 * @returns {Promise<void>}
 */
async function holdFrame(page, nextIndex, copies) {
  for (let i = 0; i < copies; i += 1) {
    await captureFrame(page, nextIndex());
  }
}

/**
 * Scroll chat so the user question sits near the top and Sources stay in view below.
 * @param {import('@playwright/test').Page} page Page.
 * @param {string} question Exact user question text.
 * @returns {Promise<void>}
 */
async function scrollChatToQuestionAndAnswer(page, question) {
  await page.getByText(question, { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });
  /**
   * Pin the message list to the top so the user question and answer lead are visible.
   * ChatWorkspace auto-scrolls to the bottom on new messages — override after it settles,
   * and stub scrollTo so later effects cannot yank the viewport down before capture.
   */
  await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll('.overflow-y-auto')];
    const messagePane = scrollers.find((node) => node.className.includes('flex-1')) || scrollers.at(-1);
    if (!messagePane) return;
    messagePane.scrollTo = function scrollToPatched(arg) {
      const top = typeof arg === 'number' ? arg : (arg?.top ?? 0);
      // Allow only upward / top pins during capture; ignore scroll-to-bottom.
      if (top > 32) return;
      Object.getPrototypeOf(HTMLElement.prototype).scrollTo.call(this, arg);
    };
    messagePane.scrollTop = 0;
  });
  await sleep(200);
  await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll('.overflow-y-auto')];
    const messagePane = scrollers.find((node) => node.className.includes('flex-1')) || scrollers.at(-1);
    if (messagePane) messagePane.scrollTop = 0;
  });
  await sleep(150);
}

/**
 * Main capture flow.
 */
async function main() {
  await rm(FRAMES, { recursive: true, force: true });
  await mkdir(FRAMES, { recursive: true });
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  let frame = 0;
  const nextIndex = () => frame++;

  const apiToken = await loginForApi(context.request);
  await resetDemoTenantProjects(context.request, apiToken);

  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.getByLabel(/^email$/i).fill(EMAIL);
    await page.getByLabel(/^password$/i).fill(PASSWORD);
    await page.getByRole('button', { name: /^log in$/i }).click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20000 });
    await page.waitForLoadState('networkidle');
    await injectCaptureStyles(page);
    await sleep(300);

    await page.getByRole('link', { name: /^projects$/i }).click();
    await page.waitForLoadState('networkidle');
    await sleep(300);
    await holdFrame(page, nextIndex, framesForSeconds(0.4));

    await page.getByRole('button', { name: /^create project$/i }).click();
    const createDialog = page.locator('[role="dialog"]');
    await waitForDialogIdleOpen(page, createDialog);

    const projectName = CAPTURE_FLOW_PROJECT_NAME;
    await page.locator('#pname').fill(projectName);
    await createDialog.getByRole('button', { name: /connect repository/i }).click();
    await sleep(150);
    // Key beat: filled Create project modal (≥2s).
    await holdFrame(page, nextIndex, framesForSeconds(2));

    await createDialog.getByRole('button', { name: /continue to connect/i }).click();
    const repoDialog = page.getByRole('dialog', { name: /connect repository/i });
    await page.getByLabel(/repository url/i).waitFor({ timeout: 15000 });
    await waitForDialogIdleOpen(page, repoDialog);
    await page.getByLabel(/repository url/i).fill(REPO_URL);
    await sleep(150);
    // Key beat: Connect repository with URL (≥2s).
    await holdFrame(page, nextIndex, framesForSeconds(2));

    await repoDialog.getByRole('button', { name: /^connect repository$/i }).click();
    await sleep(2500);
    await waitForDialogIdleOpen(page, repoDialog).catch(() => {});

    if (await page.getByLabel(/access token/i).isVisible().catch(() => false)) {
      await page.keyboard.press('Escape');
      await sleep(150);
      await page.keyboard.press('Escape');
      await waitForDialogIdleClosed(page);
    } else if (await repoDialog.getByRole('button', { name: /^connect repository$/i }).isVisible().catch(() => false)) {
      await repoDialog.getByRole('button', { name: /^connect repository$/i }).click();
      await sleep(2000);
      if (await page.locator('[role="dialog"]').count()) {
        await page.keyboard.press('Escape');
        await sleep(150);
        await page.keyboard.press('Escape');
      }
      await waitForDialogIdleClosed(page);
    } else if (await page.locator('[role="dialog"]').count()) {
      await page.keyboard.press('Escape');
      await sleep(150);
      await page.keyboard.press('Escape');
      await waitForDialogIdleClosed(page);
    }

    await softDeleteProjectByName(context.request, apiToken, projectName);

    /** @type {{ items?: Array<{ id: string, name: string }> }} */
    const listed = /** @type {any} */ (await apiJson(context.request, apiToken, 'GET', '/projects?limit=100'));
    const readyProject = (Array.isArray(listed?.items) ? listed.items : []).find(
      (p) => String(p.name || '').trim().toLowerCase() === 'prepayment advisor',
    );
    if (!readyProject?.id) {
      throw new Error('prepayment advisor project not found after demo reset');
    }

    await page.goto(`${BASE}/processing?projectId=${encodeURIComponent(readyProject.id)}`, {
      waitUntil: 'networkidle',
    });
    await injectCaptureStyles(page);
    await sleep(400);
    await page.getByText(/ready to explore|knowledge ready|\bready\b/i).first().waitFor({
      state: 'visible',
      timeout: 15000,
    });
    // Key beat: processing screen showing ready (≥2s).
    await holdFrame(page, nextIndex, framesForSeconds(2));

    await page.goto(`${BASE}/projects/${readyProject.id}/chat`, { waitUntil: 'networkidle' });
    await injectCaptureStyles(page);
    await sleep(400);
    await page.getByRole('button', { name: /^new chat$/i }).click();
    await sleep(300);
    await holdFrame(page, nextIndex, framesForSeconds(0.4));

    const question = 'How does authentication work in this project?';
    const composer = page.getByPlaceholder(/ask anything about/i);
    await composer.waitFor({ state: 'visible', timeout: 15000 });
    await composer.fill(question);
    await sleep(200);
    // Key beat: chat question typed before sending (≥2s).
    await holdFrame(page, nextIndex, framesForSeconds(2));

    await page.getByRole('button', { name: /^send$/i }).click();
    const sourcesToggle = page.getByRole('button', { name: /\d+\s+sources?/i });
    await sourcesToggle.first().waitFor({ state: 'visible', timeout: 30000 });
    await page.getByText(/How authentication works|JWT-based session/i).first().waitFor({ timeout: 15000 });
    await sleep(400);
    await sourcesToggle.first().click();
    await page.locator('pre').first().waitFor({ state: 'visible', timeout: 10000 });
    await sleep(200);
    await scrollChatToQuestionAndAnswer(page, question);
    // Final beat: cited answer with Sources (≥4s). GIF must end here.
    await holdFrame(page, nextIndex, framesForSeconds(4));

    const lastFramePath = join(FRAMES, `frame_${String(frame - 1).padStart(3, '0')}.png`);
    await copyFile(lastFramePath, join(OUT, 'hero-chat-evidence.png'));

    const beforeReject = frame;
    const { kept, minLuma, maxLuma } = await rejectDarkFrames(FRAMES);
    const durationSec = kept / GIF_FPS;
    console.log(
      `Frames captured=${beforeReject}, kept=${kept}, duration≈${durationSec.toFixed(1)}s, full-frame luma min=${minLuma} max=${maxLuma} (floor ${MIN_FRAME_LUMA})`,
    );
    if (kept < 8) {
      throw new Error(`Too few frames after dark reject (${kept})`);
    }
    if (minLuma < MIN_FRAME_LUMA) {
      throw new Error(`Frame luma floor failed: min=${minLuma} < ${MIN_FRAME_LUMA}`);
    }
    if (durationSec > GIF_MAX_SECONDS) {
      throw new Error(`GIF duration ${durationSec.toFixed(1)}s exceeds ${GIF_MAX_SECONDS}s budget`);
    }

    await encodeGif(FRAMES, join(OUT, 'demo-create-repo-chat.gif'));

    console.log(`Wrote docs/images/demo-create-repo-chat.gif (${kept} frames @ ${GIF_FPS}fps, ≈${durationSec.toFixed(1)}s)`);
    console.log('Wrote hero-chat-evidence.png');
  } finally {
    await browser.close();
    await rm(FRAMES, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
