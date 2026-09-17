import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { HarnessConfig } from "../src/config.js";
import { HarnessUiServer } from "../src/ui/index.js";

function testConfig(dataDirectory = ".harness"): HarnessConfig {
  return {
    dataDirectory,
    maxRevisionRounds: 2,
    requireCleanRepository: true,
    router: { baseUrl: "http://127.0.0.1:20128/v1", required: false },
    codex: { command: "codex", reasoningEffort: "high", timeoutMs: 10_000 },
    antigravity: { command: "agy", effort: "high", timeoutMs: 10_000 },
    validation: {
      timeoutMs: 10_000,
      allowedExecutables: [path.basename(process.execPath).toLowerCase()],
    },
    parallel: { maxWorkers: 2, maxTasks: 4 },
  };
}

const repoRoot = path.resolve(process.cwd());
const uiDir = path.join(repoRoot, "ui");

test("required dashboard assets exist and are non-empty", async () => {
  const indexStat = await stat(path.join(uiDir, "index.html"));
  assert.ok(indexStat.isFile());
  assert.ok(indexStat.size > 200, "index.html must not be empty");

  const stylesStat = await stat(path.join(uiDir, "styles.css"));
  assert.ok(stylesStat.isFile());
  assert.ok(stylesStat.size > 200, "styles.css must not be empty");

  const appStat = await stat(path.join(uiDir, "app.js"));
  assert.ok(appStat.isFile());
  assert.ok(appStat.size > 200, "app.js must not be empty");
});

test("absence of remote dependencies and CDN assets", async () => {
  const indexHtml = await readFile(path.join(uiDir, "index.html"), "utf8");
  const stylesCss = await readFile(path.join(uiDir, "styles.css"), "utf8");
  const appJs = await readFile(path.join(uiDir, "app.js"), "utf8");

  const allCode = `${indexHtml}\n${stylesCss}\n${appJs}`;

  // Prohibit external protocols in asset links
  assert.doesNotMatch(indexHtml, /<script[^>]+src=["']https?:\/\//i);
  assert.doesNotMatch(indexHtml, /<link[^>]+href=["']https?:\/\//i);

  // Prohibit popular CDNs and external font services
  const forbiddenRemotes = [
    "cdnjs.cloudflare.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "use.fontawesome.com",
    "maxcdn.bootstrapcdn.com",
    "code.jquery.com",
  ];

  for (const domain of forbiddenRemotes) {
    assert.equal(
      allCode.includes(domain),
      false,
      `Detected remote CDN or font dependency: ${domain}`,
    );
  }

  // Prohibit remote CSS imports
  assert.doesNotMatch(stylesCss, /@import\s+(?:url\(['"]?https?:|['"]https?:)/i);
});

test("safe DOM rendering policy enforces textContent and strictly prohibits innerHTML", async () => {
  const appJs = await readFile(path.join(uiDir, "app.js"), "utf8");

  // Zero assignments to innerHTML or outerHTML
  assert.doesNotMatch(
    appJs,
    /\.innerHTML\s*=/,
    "ui/app.js must not assign to innerHTML",
  );
  assert.doesNotMatch(
    appJs,
    /\.outerHTML\s*=/,
    "ui/app.js must not assign to outerHTML",
  );

  // Prohibit dangerous direct DOM injection methods
  assert.doesNotMatch(
    appJs,
    /\.insertAdjacentHTML\s*\(/,
    "ui/app.js must not use insertAdjacentHTML",
  );
  assert.doesNotMatch(
    appJs,
    /document\.write(?:ln)?\s*\(/,
    "ui/app.js must not use document.write",
  );

  // Must construct safe DOM nodes using createElement and textContent / createTextNode
  assert.ok(appJs.includes("textContent"), "app.js must render values via textContent");
  assert.ok(appJs.includes("document.createElement"), "app.js must build DOM safely");
  assert.ok(appJs.includes("document.createTextNode"), "app.js must create text nodes safely");
});

test("API route usage covers all required endpoints", async () => {
  const appJs = await readFile(path.join(uiDir, "app.js"), "utf8");

  // Parallel runs listing
  assert.ok(
    appJs.includes("/api/parallel-runs"),
    "app.js must call or reference /api/parallel-runs",
  );

  // Health endpoint
  assert.ok(
    appJs.includes("/api/health"),
    "app.js must call or reference /api/health",
  );

  // Sub-routes for selected run details
  assert.ok(appJs.includes("/events"), "app.js must fetch run events");
  assert.ok(appJs.includes("/integration-review"), "app.js must fetch integration review");
  assert.ok(appJs.includes("/integration-checks"), "app.js must fetch integration checks");
  assert.ok(appJs.includes("/integration-diff"), "app.js must fetch integration diff");
});

test("accessibility hooks and semantic landmarks in HTML and CSS", async () => {
  const indexHtml = await readFile(path.join(uiDir, "index.html"), "utf8");
  const stylesCss = await readFile(path.join(uiDir, "styles.css"), "utf8");

  // 1. Semantic landmarks and language
  assert.ok(indexHtml.includes('<html lang="en">'), "Must declare html lang attribute");
  assert.ok(indexHtml.includes('<meta name="viewport"'), "Must include viewport meta tag");
  assert.ok(indexHtml.includes("<title>"), "Must include title tag");
  assert.ok(indexHtml.includes("<header"), "Must include header element");
  assert.ok(indexHtml.includes("<main"), "Must include main element");
  assert.ok(indexHtml.includes("<aside"), "Must include aside element");
  assert.ok(indexHtml.includes('class="skip-link"'), "Must include keyboard skip link");

  // 2. ARIA roles and live regions
  assert.ok(indexHtml.includes('role="status"'), "Must include role=status for live updates");
  assert.ok(indexHtml.includes('aria-live="polite"'), "Must include aria-live=polite");
  assert.ok(indexHtml.includes('role="alert"'), "Must include alert landmark for critical feedback");
  assert.ok(indexHtml.includes('role="listbox"'), "Must include accessible listbox for runs");

  // 3. CSS accessibility hooks: focus, reduced-motion, and responsive design
  assert.ok(stylesCss.includes(":focus-visible"), "styles.css must style visible focus states");
  assert.ok(
    stylesCss.includes("prefers-reduced-motion"),
    "styles.css must support reduced-motion preference",
  );
  assert.ok(
    stylesCss.includes("@media (max-width:"),
    "styles.css must provide responsive mobile layout",
  );
});

test("server serves real ui static assets with correct content types and headers", async () => {
  const server = new HarnessUiServer(testConfig(), repoRoot, { host: "127.0.0.1", port: 0 });
  try {
    await server.start();

    // 1. GET / serves index.html
    const indexRes = await fetch(`${server.url}/`);
    assert.equal(indexRes.status, 200);
    assert.equal(indexRes.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(indexRes.headers.get("x-content-type-options"), "nosniff");
    const indexBody = await indexRes.text();
    assert.ok(indexBody.includes("AI Dev Team Harness"));
    assert.ok(indexBody.includes("Parallel Operations Console"));
    assert.ok(indexBody.includes("styles.css"));
    assert.ok(indexBody.includes("app.js"));

    // 2. GET /styles.css serves CSS
    const cssRes = await fetch(`${server.url}/styles.css`);
    assert.equal(cssRes.status, 200);
    assert.equal(cssRes.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(cssRes.headers.get("x-content-type-options"), "nosniff");
    const cssBody = await cssRes.text();
    assert.ok(cssBody.includes(":root"));
    assert.ok(cssBody.includes("--bg-canvas"));

    // 3. GET /app.js serves JavaScript ES module
    const jsRes = await fetch(`${server.url}/app.js`);
    assert.equal(jsRes.status, 200);
    assert.equal(jsRes.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(jsRes.headers.get("x-content-type-options"), "nosniff");
    const jsBody = await jsRes.text();
    assert.ok(jsBody.includes("/api/parallel-runs"));
    assert.ok(jsBody.includes("textContent"));

    // 4. Missing resource returns 404
    const notFoundRes = await fetch(`${server.url}/non-existent-asset.xyz`);
    assert.equal(notFoundRes.status, 404);
  } finally {
    await server.stop();
  }
});

test("state timeline progression and badges cover all defined parallel run states", async () => {
  const appJs = await readFile(path.join(uiDir, "app.js"), "utf8");
  const indexHtml = await readFile(path.join(uiDir, "index.html"), "utf8");

  // All parallel run states from ParallelRunStateSchema
  const states = [
    "RECEIVED",
    "PLANNING",
    "SHARDS_RUNNING",
    "INTEGRATING",
    "INTEGRATION_CHECKING",
    "INTEGRATION_REVIEWING",
    "DONE",
    "REPLAN_REQUIRED",
    "FAILED",
  ];

  for (const st of states) {
    assert.ok(
      appJs.includes(`"${st}"`) || appJs.includes(`'${st}'`),
      `app.js must handle state: ${st}`,
    );
  }

  // Lifecycle stages present in index.html stage tracker
  const primaryStages = [
    "RECEIVED",
    "PLANNING",
    "SHARDS_RUNNING",
    "INTEGRATING",
    "INTEGRATION_CHECKING",
    "INTEGRATION_REVIEWING",
    "DONE",
  ];

  for (const stage of primaryStages) {
    assert.ok(
      indexHtml.includes(`data-stage="${stage}"`),
      `index.html must define stage step for: ${stage}`,
    );
  }
});
