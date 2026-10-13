import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// Enter twice while the agent works (Settings → Enter twice sends now), on the unmodified app over
// the demo's fixture transport: the first Enter queues the message, a second within a second sends
// it now, as its Send now does — also when it comes before the bridge's receipt for the first. A
// single Enter, a second one too late, or the setting off leaves it queued. The demo's mock turn
// takes 2.4 s and sends what is still queued when it ends, so a message sent now is one that joins
// the chat while the turn still works. All files and HTTP traffic stay in this disposable,
// loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-enter-twice-demo-"));

// playwright-core's bundle lazily requires packages the lockfile does not carry (chromium-bidi):
// fine at run time, unresolvable to `bun build` — so it is imported past the bundler's analysis
const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

/** The user turns the chat shows, in order. */
const userTurns = (page: Page): Promise<string[]> => page.locator(".chat-turn-user .chat-bubble").allTextContents();
/** The demo turn's answers so far: a message sent now joins the chat before the running turn's answer. */
const answers = (page: Page): Promise<number> => page.locator(".chat-turn-agent", { hasText: "This is the demo, so nothing ran" }).count();
const pendingRows = (page: Page): Promise<string[]> => page.locator(".pending-message-bubble").allTextContents();
/** The agent works: the empty box's control is Stop. */
const working = (page: Page): Promise<void> => page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ timeout: 10_000 });

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Over the demo's sockets: window.submitDelayMs holds a submit back that long before the demo
  // sees it, so its receipt comes after a quick second Enter
  const delay = `<script>(() => {
    const Demo = window.WebSocket;
    window.submitDelayMs = 0;
    const Delaying = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const message = typeof data === "string" ? JSON.parse(data) : null;
        if (window.submitDelayMs > 0 && message !== null && message.type === "submit") setTimeout(() => send(data), window.submitDelayMs);
        else send(data);
      };
      return socket;
    };
    Delaying.prototype = Demo.prototype;
    Object.setPrototypeOf(Delaying, Demo);
    window.WebSocket = Delaying;
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${delay}\n    <script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.infra)}`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const run = async (settings: Record<string, unknown>, check: (page: Page, send: (text: string) => Promise<void>) => Promise<void>): Promise<void> => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
        try {
          await context.addInitScript(([paneId, stored]) => {
            localStorage.setItem("herdr-web-ui:settings", stored);
            localStorage.setItem(`herdr-web-ui:view:${paneId}`, "chat");
          }, [panes.infra, JSON.stringify({ language: "en", ...settings })] as const);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.locator(".terminal-stack.is-chat").waitFor();
          const composer = page.getByRole("textbox", { name: "Message", exact: true });
          await composer.focus();
          // a first message starts the demo's turn: what follows is sent while the agent works
          await composer.fill("start the turn");
          await page.keyboard.press("Enter");
          await page.waitForFunction(() => [...document.querySelectorAll(".chat-turn-user")].some((turn) => turn.textContent?.includes("start the turn")), undefined, { timeout: 10_000 });
          await working(page);
          await check(page, async (text) => { await composer.fill(text); await page.keyboard.press("Enter"); });
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      };

      await run({}, async (page, send) => {
        const turnsBefore = (await userTurns(page)).length;
        await send("steer this");
        await page.locator(".pending-message-bubble", { hasText: "steer this" }).waitFor();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => [...document.querySelectorAll(".chat-turn-user")].some((turn) => turn.textContent?.includes("steer this")), undefined, { timeout: 1_500 });
        assert.equal((await userTurns(page)).length, turnsBefore + 1);
        assert.equal(await answers(page), 0, "it went while the turn still worked, not when the turn ended");
        assert.deepEqual(await pendingRows(page), [], "the row went with its message");
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "", "the box stays empty");
        console.log("PASS Enter twice while the agent works sends the queued message now");
      });

      await run({}, async (page, send) => {
        await page.evaluate(() => { (window as unknown as { submitDelayMs: number }).submitDelayMs = 400; });
        await send("before its receipt");
        // the second Enter lands while the first is still on its way: the box still holds the text
        await page.keyboard.press("Enter");
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "before its receipt", "the first send is still on its way");
        await page.waitForFunction(() => [...document.querySelectorAll(".chat-turn-user")].some((turn) => turn.textContent?.includes("before its receipt")), undefined, { timeout: 1_800 });
        assert.deepEqual(await pendingRows(page), []);
        assert.equal((await userTurns(page)).filter((text) => text.includes("before its receipt")).length, 1, "sent once");
        assert.equal(await answers(page), 0, "it went while the turn still worked, not when the turn ended");
        console.log("PASS a second Enter before the bridge's receipt sends the message once it is held");
      });

      await run({}, async (page, send) => {
        await send("one enter only");
        await page.locator(".pending-message-bubble", { hasText: "one enter only" }).waitFor();
        await page.waitForTimeout(1_100);
        // too late to be the second of two: Enter on the empty box does nothing
        await page.keyboard.press("Enter");
        await page.waitForTimeout(400);
        assert.deepEqual(await pendingRows(page), ["one enter only"], "still waits for its turn");
        assert.ok((await userTurns(page)).every((text) => !text.includes("one enter only")));
        console.log("PASS one Enter, or a second one after a second, leaves the message queued for its turn");
      });

      await run({ enterTwiceSteers: false }, async (page, send) => {
        await send("setting off");
        await page.locator(".pending-message-bubble", { hasText: "setting off" }).waitFor();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(400);
        assert.deepEqual(await pendingRows(page), ["setting off"]);
        console.log("PASS with Enter twice sends now off, a second Enter leaves the message queued");
      });

      // with automatic sending off a message waits for Send now: Enter twice is that Send now
      await run({ autoSendQueued: false }, async (page, send) => {
        await send("held then sent");
        await page.locator(".pending-message-bubble", { hasText: "held then sent" }).waitFor();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => [...document.querySelectorAll(".chat-turn-user")].some((turn) => turn.textContent?.includes("held then sent")), undefined, { timeout: 1_500 });
        assert.deepEqual(await pendingRows(page), []);
        console.log("PASS a message held for Send now goes with a second Enter");
      });
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
