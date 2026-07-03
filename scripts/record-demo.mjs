// Minimum "approach A" demo recorder.
//
// Pipeline: download a clean VS Code build -> launch it with our extension
// loaded and a remote-debugging port open -> attach Playwright over CDP ->
// reveal the Acurast Studio panel -> click through a few routes, screenshotting
// each step -> assemble the frames into media/demo.gif with ffmpeg.
//
// This is intentionally a SLIDESHOW (one frame per action), just enough to
// prove the launch -> connect -> drive -> capture -> encode chain end to end.
// Smooth motion, seeded wallet/deploy scenes, and CI wiring come later.
//
//   npm run build:dev && npm run record:demo
//
// Requires: ffmpeg on PATH (for the final GIF encode). Without it, the script
// still produces the raw PNG frames and tells you how to encode them yourself.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { chromium } from "playwright-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const WORKSPACE = join(REPO_ROOT, "fixtures", "demo-workspace");
const OUT_DIR = join(REPO_ROOT, "media");
const FRAMES_DIR = join(OUT_DIR, ".demo-frames");
const GIF_PATH = join(OUT_DIR, "demo.gif");
const DEBUG_PORT = 9229;
const WINDOW = { width: 1280, height: 820 };
// Pre-roll pause after the panel is ready, before the first frame is captured.
// Lets the UI fully settle (and gives you a moment to watch). Override with
// e.g. DEMO_START_DELAY=8000 npm run record:demo
const START_DELAY_MS = Number(process.env.DEMO_START_DELAY ?? 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the CDP endpoint until VS Code's debugger is accepting connections. */
async function waitForDebugger(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`VS Code debugger never came up on port ${DEBUG_PORT}`);
}

/** Find the main workbench page among all CDP targets. */
async function findWorkbench(browser, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        const url = page.url();
        if (url.includes("workbench") || url.endsWith("workbench.html")) {
          return page;
        }
      }
    }
    await sleep(500);
  }
  throw new Error("Could not find the VS Code workbench page over CDP");
}

let frameIndex = 0;
async function frame(page, label, clip) {
  const n = String(frameIndex++).padStart(3, "0");
  await page.screenshot({ path: join(FRAMES_DIR, `frame-${n}.png`), clip: clip ?? undefined });
  console.log(`  📸 frame ${n}${label ? ` — ${label}` : ""}`);
}

// Crop the panel to roughly where content ends, so the GIF isn't a tall strip
// with a big empty dark area below the nav cards. CSS px; override with
// DEMO_PANEL_HEIGHT=700 npm run record:demo
const PANEL_HEIGHT_PX = Number(process.env.DEMO_PANEL_HEIGHT ?? 600);

/** Bounding box covering the activity bar + side bar (our panel surface). */
async function panelClip(page) {
  const maxHeight = PANEL_HEIGHT_PX;
  return page.evaluate((maxH) => {
    const a = document.querySelector(".part.activitybar")?.getBoundingClientRect();
    const s = document.querySelector(".part.sidebar")?.getBoundingClientRect();
    if (!a || !s) return null;
    return {
      x: Math.floor(a.x),
      y: Math.floor(a.y),
      width: Math.ceil(s.x + s.width - a.x),
      height: Math.min(Math.floor(a.height), maxH),
    };
  }, maxHeight);
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", rej);
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

async function hasFfmpeg() {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Fresh frames dir each run.
  rmSync(FRAMES_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });

  console.log("⬇️  Resolving VS Code build…");
  const vscodePath = await downloadAndUnzipVSCode();
  const userDataDir = mkdtempSync(join(tmpdir(), "acurast-demo-"));
  const extensionsDir = mkdtempSync(join(tmpdir(), "acurast-demo-ext-"));

  // Generic project location for the seeded deployment's "source path", so the
  // History card shows a neutral /tmp/... path (with an Open button) instead of
  // this machine's real repo path. Must exist on disk or the card warns.
  // Use literal /tmp on posix for a clean display (tmpdir() is /var/folders/...).
  const cleanTmp = process.platform === "win32" ? tmpdir() : "/tmp";
  const demoProjectDir = join(cleanTmp, "acurast-studio-demo");
  mkdirSync(demoProjectDir, { recursive: true });
  copyFileSync(join(WORKSPACE, "acurast.json"), join(demoProjectDir, "acurast.json"));
  const demoProjectPath = join(demoProjectDir, "acurast.json");

  // Seed a clean profile so nothing distracts from our panel: no startup
  // editor, no git "open repository?" prompt, no telemetry/command-center.
  const settings = {
    "workbench.startupEditor": "none",
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.tips.enabled": false,
    "git.openRepositoryInParentFolders": "never",
    "telemetry.telemetryLevel": "off",
    "window.commandCenter": false,
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "chat.commandCenter.enabled": false,
  };

  // Optional: show live fiat in the deploy panel by seeding a CoinGecko
  // currency (otherwise currencyId defaults to "" and fiat is disabled).
  // The CoinGecko public API is keyless, so no key is seeded.
  //   DEMO_FIAT_CURRENCY=usd npm run record:demo
  const fiatCurrency = process.env.DEMO_FIAT_CURRENCY?.trim();
  if (fiatCurrency) {
    settings["acurast.fiat.exchangerId"] = 2; // CoinGecko
    settings["acurast.fiat.currencyId"] = fiatCurrency;
    settings["acurast.fiat.coingecko.plan"] = "demo";
    console.log(`💱 Fiat enabled for recording: CoinGecko / ${fiatCurrency}`);
  }

  mkdirSync(join(userDataDir, "User"), { recursive: true });
  writeFileSync(join(userDataDir, "User", "settings.json"), JSON.stringify(settings, null, 2));

  console.log("🚀 Launching VS Code…");
  const proc = spawn(
    vscodePath,
    [
      WORKSPACE,
      `--extensionDevelopmentPath=${REPO_ROOT}`,
      `--user-data-dir=${userDataDir}`,
      // Isolated, empty extensions dir → no third-party extensions load (no
      // Deno, Copilot, etc. from the real ~/.vscode/extensions). We do NOT
      // pass --disable-extensions because that also disables BUILT-IN ones,
      // including the color theme — the git "open repository?" prompt is
      // instead suppressed via the git.openRepositoryInParentFolders setting.
      `--extensions-dir=${extensionsDir}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-telemetry",
      "--no-sandbox",
    ],
    // Seeding is enabled by the `build:record` build (esbuild __ACURAST_DEV_SEED__
    // flag), not an env var — so published builds never contain the demo code.
    // ACURAST_DEMO_PROJECT_PATH points the sample deployment's source at a
    // generic /tmp path so the history card renders cleanly.
    {
      stdio: "ignore",
      env: { ...process.env, ACURAST_DEMO_PROJECT_PATH: demoProjectPath },
    },
  );

  let browser;
  try {
    await waitForDebugger();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
    const page = await findWorkbench(browser);

    // Best-effort: pin the window to a consistent size for stable framing.
    try {
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { ...WINDOW, windowState: "normal" },
      });
    } catch (e) {
      console.warn("  (could not set window bounds — continuing)", e.message);
    }

    // Wait for the workbench shell, then for our extension to activate
    // (activation is gated on workspaceContains:acurast.json).
    await page.waitForSelector(".monaco-workbench", { timeout: 60_000 });
    await page.waitForSelector('.activitybar [aria-label*="Acurast"]', { timeout: 60_000 });
    await sleep(1_500);

    // Close the AI Chat (secondary side bar) if it opened. Cmd/Ctrl+Alt+B is
    // the stable default keybinding for "Toggle Secondary Side Bar".
    const auxVisible = await page.evaluate(() => {
      const el = document.querySelector(".part.auxiliarybar");
      return !!el && el.getBoundingClientRect().width > 0;
    });
    if (auxVisible) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+B" : "Control+Alt+B");
      await sleep(600);
      console.log("  🚪 closed AI Chat side bar");
    }

    // Reveal the Acurast Studio panel via the activity bar.
    console.log("🧭 Opening Acurast Studio panel…");
    await page.click('.activitybar [aria-label*="Acurast"]');

    // Wait for the webview to actually render before screenshotting.
    // Nested iframe: outer .webview → inner #active-frame.
    const inner = page
      .frameLocator("iframe.webview.ready")
      .frameLocator("iframe#active-frame");
    await inner.locator(".nav-card").first().waitFor({ timeout: 30_000 });
    await sleep(1_000);

    // Clip every frame to just the activity bar + side bar (our panel),
    // excluding the empty editor, Chat sidebar, and notification toasts.
    const clip = await panelClip(page);

    if (START_DELAY_MS > 0) {
      console.log(`⏸️  pausing ${START_DELAY_MS}ms before recording…`);
      await sleep(START_DELAY_MS);
    }

    await frame(page, "studio home", clip);

    // The "Home" button is a VIEW-TITLE action (in the panel header, not the
    // webview), shown only when route != home. Target it on the page.
    const homeBtn = page.locator('.composite.title [aria-label*="Home"]');

    // Storyboard: click each route's nav card, capture, return Home.
    // `holdMs` keeps the route open longer (e.g. to interact or inspect)
    // before the frame is captured and we navigate back.
    const routes = [
      { label: "Project Settings" },
      { label: "Wallets" },
      { label: "Deployments" },
      { label: "History" },
      { label: "Tunnel DNS" },
    ];
    for (const { label, holdMs } of routes) {
      try {
        await inner.getByText(label, { exact: true }).first().click({ timeout: 10_000 });
        await sleep(1_500);
        if (holdMs) {
          console.log(`  ⏸️  holding ${holdMs}ms on "${label}"…`);
          await sleep(holdMs);
        }
        await frame(page, `route: ${label}`, clip);
        await homeBtn.first().click({ timeout: 10_000 });
        await inner.locator(".nav-card").first().waitFor({ timeout: 10_000 });
        await sleep(800);
      } catch (e) {
        console.warn(`  (skipped route "${label}": ${e.message.split("\n")[0]})`);
      }
    }

    await frame(page, "final", clip);
  } finally {
    if (browser) await browser.close().catch(() => {});
    proc.kill();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(extensionsDir, { recursive: true, force: true });
  }

  const frames = readdirSync(FRAMES_DIR).filter((f) => f.endsWith(".png"));
  if (frames.length === 0) throw new Error("No frames captured — nothing to encode.");
  console.log(`\n🎞️  Captured ${frames.length} frames in ${FRAMES_DIR}`);

  if (await hasFfmpeg()) {
    console.log("🪄 Encoding GIF with ffmpeg…");
    await run("ffmpeg", [
      "-y",
      "-framerate", "1.5",
      "-i", join(FRAMES_DIR, "frame-%03d.png"),
      "-vf",
      "fps=10,scale=720:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      "-loop", "0",
      GIF_PATH,
    ]);
    console.log(`\n✅ Done → ${GIF_PATH}`);
  } else {
    console.log(
      `\n⚠️  ffmpeg not found. Frames are in ${FRAMES_DIR}.\n` +
        `   Install ffmpeg, then run:\n` +
        `   ffmpeg -framerate 1.5 -i "${join(FRAMES_DIR, "frame-%03d.png")}" ` +
        `-vf "fps=10,scale=720:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "${GIF_PATH}"`,
    );
  }
}

main().catch((err) => {
  console.error("\n❌ record-demo failed:", err);
  process.exit(1);
});
