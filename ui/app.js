/**
 * AI Dev Team Harness — Operations Console
 * Local-first client application with zero external dependencies.
 * Safe DOM rendering: strictly uses textContent, document.createElement, and DOM node construction.
 * No untrusted values are ever assigned to innerHTML.
 */

// Configuration constants
const POLL_INTERVAL_MS = 3500;
const RUNS_API = "/api/parallel-runs";
const HEALTH_API = "/api/health";

// Application state
let runs = [];
let selectedRunId = null;
let pollTimer = null;
let isPolling = false;
let consecutiveFailures = 0;
let lastSelectedDiffText = "";

/**
 * Safe DOM element builder.
 * Never sets innerHTML. Uses textContent and safe attributes.
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val === undefined || val === null) continue;
    if (key === "className") {
      node.className = val;
    } else if (key === "textContent") {
      node.textContent = String(val);
    } else if (key.startsWith("on") && typeof val === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (key === "disabled") {
      if (val) node.setAttribute("disabled", "");
      else node.removeAttribute("disabled");
    } else {
      node.setAttribute(key, String(val));
    }
  }

  const childList = Array.isArray(children) ? children : [children];
  for (const child of childList) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      node.appendChild(child);
    }
  }
  return node;
}

/**
 * Safe JSON fetcher with error propagation
 */
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    let errorDetail = res.statusText;
    try {
      const body = await res.json();
      if (body && body.error) errorDetail = body.error;
    } catch {
      // Use statusText fallback
    }
    const err = new Error(`Request failed (${res.status}): ${errorDetail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * State badge class determination
 */
function getStateBadgeClass(state) {
  switch (state) {
    case "DONE":
    case "APPROVED":
      return "badge-green";
    case "SHARDS_RUNNING":
    case "INTEGRATING":
    case "INTEGRATION_CHECKING":
    case "INTEGRATION_REVIEWING":
    case "PLANNING":
      return "badge-cyan";
    case "REPLAN_REQUIRED":
      return "badge-amber";
    case "FAILED":
    case "changes_requested":
      return "badge-red";
    case "RECEIVED":
    default:
      return "badge-neutral";
  }
}

/**
 * Update connection health UI indicator
 */
function updateConnectionStatus(status, message) {
  const dot = document.getElementById("connection-dot");
  const label = document.getElementById("connection-label");
  const timeEl = document.getElementById("last-poll-time");

  if (!dot || !label || !timeEl) return;

  dot.className = "status-dot";
  if (status === "connected") {
    dot.classList.add("dot-connected");
    label.textContent = "Connected";
    timeEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } else if (status === "stale") {
    dot.classList.add("dot-stale");
    label.textContent = "Connection Stale";
    timeEl.textContent = message || "Retrying...";
  } else if (status === "disconnected") {
    dot.classList.add("dot-disconnected");
    label.textContent = "Disconnected";
    timeEl.textContent = message || "Cannot reach API";
  } else {
    dot.classList.add("dot-connecting");
    label.textContent = "Connecting...";
    timeEl.textContent = message || "Connecting to local harness";
  }
}

/**
 * Calculate and render top metrics bar
 */
function updateMetricsBar(runList) {
  const totalEl = document.getElementById("stat-total");
  const runningEl = document.getElementById("stat-running");
  const doneEl = document.getElementById("stat-done");
  const failedEl = document.getElementById("stat-failed");
  const countBadge = document.getElementById("runs-count-badge");

  const total = runList.length;
  let running = 0;
  let done = 0;
  let failed = 0;

  const runningStates = new Set([
    "RECEIVED",
    "PLANNING",
    "SHARDS_RUNNING",
    "INTEGRATING",
    "INTEGRATION_CHECKING",
    "INTEGRATION_REVIEWING",
  ]);

  for (const r of runList) {
    if (r.state === "DONE") {
      done++;
    } else if (r.state === "FAILED" || r.state === "REPLAN_REQUIRED") {
      failed++;
    } else if (runningStates.has(r.state)) {
      running++;
    }
  }

  if (totalEl) totalEl.textContent = String(total);
  if (runningEl) runningEl.textContent = String(running);
  if (doneEl) doneEl.textContent = String(done);
  if (failedEl) failedEl.textContent = String(failed);
  if (countBadge) countBadge.textContent = String(total);
}

/**
 * Render run list in the sidebar
 */
function renderSidebarList() {
  const listEl = document.getElementById("run-list");
  const searchInput = document.getElementById("run-search");
  const feedbackEl = document.getElementById("sidebar-feedback");
  if (!listEl) return;

  const filterQuery = searchInput ? searchInput.value.trim().toLowerCase() : "";

  const filteredRuns = runs.filter((r) => {
    if (!filterQuery) return true;
    return (
      (r.id && r.id.toLowerCase().includes(filterQuery)) ||
      (r.state && r.state.toLowerCase().includes(filterQuery)) ||
      (r.message && r.message.toLowerCase().includes(filterQuery))
    );
  });

  listEl.replaceChildren();

  if (feedbackEl) {
    if (filterQuery) {
      feedbackEl.classList.remove("hidden");
      feedbackEl.textContent = `Showing ${filteredRuns.length} of ${runs.length} runs`;
    } else {
      feedbackEl.classList.add("hidden");
      feedbackEl.textContent = "";
    }
  }

  if (runs.length === 0) {
    listEl.appendChild(
      el("li", {
        className: "run-list-item empty-list-item",
        textContent: "No parallel runs found in .harness/parallel-runs",
      })
    );
    return;
  }

  if (filteredRuns.length === 0) {
    listEl.appendChild(
      el("li", {
        className: "run-list-item empty-list-item",
        textContent: "No runs match your filter query",
      })
    );
    return;
  }

  for (const run of filteredRuns) {
    const isSelected = run.id === selectedRunId;
    const badgeClass = getStateBadgeClass(run.state);

    const item = el(
      "li",
      {
        className: `run-list-item ${isSelected ? "selected" : ""}`,
        role: "option",
        tabIndex: 0,
        "aria-selected": isSelected ? "true" : "false",
        "aria-label": `Run ${run.id}, state ${run.state}`,
        onclick: () => selectRun(run.id),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectRun(run.id);
          }
        },
      },
      [
        el("div", { className: "run-list-item-top" }, [
          el("span", { className: "run-list-id", textContent: run.id, title: run.id }),
          el("span", { className: `badge ${badgeClass}`, textContent: run.state }),
        ]),
        el("div", { className: "run-list-meta" }, [
          el("span", {
            className: "run-list-shards",
            textContent: `${run.shardResults ? run.shardResults.length : 0} shards`,
          }),
        ]),
        run.message
          ? el("div", {
              className: "run-list-message",
              textContent: run.message,
              title: run.message,
            })
          : null,
      ]
    );

    listEl.appendChild(item);
  }
}

/**
 * Select a specific run by ID and load its detail
 */
function selectRun(runId) {
  if (!runId) return;
  selectedRunId = runId;

  // Sync with URL hash without triggering full reload
  try {
    const hashVal = `#run-${encodeURIComponent(runId)}`;
    if (window.location.hash !== hashVal) {
      window.history.replaceState(null, "", hashVal);
    }
  } catch {
    // Ignore history replace failure if restricted
  }

  renderSidebarList();
  fetchAndRenderSelectedRun(runId);
}

/**
 * Fetch detail endpoints independently so a missing in-progress artifact
 * does not blank the page or crash the application.
 */
async function fetchAndRenderSelectedRun(runId) {
  if (!runId) return;

  const emptyView = document.getElementById("empty-state");
  const detailView = document.getElementById("run-detail");
  if (emptyView) emptyView.classList.add("hidden");
  if (detailView) detailView.classList.remove("hidden");

  // Fetch all endpoints independently in parallel
  const [statusResult, eventsResult, reviewResult, checksResult, diffResult] =
    await Promise.allSettled([
      fetchJson(`/api/parallel-runs/${encodeURIComponent(runId)}`),
      fetchJson(`/api/parallel-runs/${encodeURIComponent(runId)}/events`),
      fetchJson(`/api/parallel-runs/${encodeURIComponent(runId)}/integration-review`),
      fetchJson(`/api/parallel-runs/${encodeURIComponent(runId)}/integration-checks`),
      fetchJson(`/api/parallel-runs/${encodeURIComponent(runId)}/integration-diff`),
    ]);

  // If user selected another run while these were in-flight, discard
  if (selectedRunId !== runId) return;

  // 1. Overview & Shards
  if (statusResult.status === "fulfilled") {
    renderOverview(statusResult.value);
    renderShards(statusResult.value.shardResults || []);
  } else {
    // Fallback: look in cached runs list
    const cached = runs.find((r) => r.id === runId);
    if (cached) {
      renderOverview(cached);
      renderShards(cached.shardResults || []);
    } else {
      renderOverviewError(statusResult.reason);
    }
  }

  // 2. Timeline & Progression
  const activeState =
    statusResult.status === "fulfilled"
      ? statusResult.value.state
      : runs.find((r) => r.id === runId)?.state || "RECEIVED";

  const events = eventsResult.status === "fulfilled" ? eventsResult.value : [];
  renderTimeline(activeState, events, eventsResult.status === "rejected");

  // 3. Integration Checks
  renderIntegrationChecks(checksResult);

  // 4. Integration Review
  renderIntegrationReview(reviewResult);

  // 5. Integration Diff
  renderIntegrationDiff(diffResult);
}

/**
 * Render overview card
 */
function renderOverview(summary) {
  const idEl = document.getElementById("detail-run-id");
  const badgeEl = document.getElementById("detail-state-badge");
  const msgEl = document.getElementById("detail-message");
  const repoEl = document.getElementById("meta-repo");
  const baseShaEl = document.getElementById("meta-base-sha");
  const branchEl = document.getElementById("meta-integration-branch");
  const commitShaEl = document.getElementById("meta-commit-sha");
  const replanBanner = document.getElementById("replan-banner");
  const replanText = document.getElementById("replan-text");
  const conflictsBanner = document.getElementById("conflicts-banner");
  const conflictsList = document.getElementById("conflicts-list");

  if (idEl) idEl.textContent = summary.id || "-";

  if (badgeEl) {
    badgeEl.textContent = summary.state || "UNKNOWN";
    badgeEl.className = `badge ${getStateBadgeClass(summary.state)}`;
  }

  if (msgEl) {
    msgEl.textContent = summary.message || "No status message provided.";
  }

  if (repoEl) repoEl.textContent = summary.repositoryPath || "-";

  if (baseShaEl) {
    baseShaEl.textContent = summary.baseSha ? summary.baseSha.slice(0, 10) : "-";
    if (summary.baseSha) baseShaEl.title = summary.baseSha;
  }

  if (branchEl) branchEl.textContent = summary.integrationBranch || "-";

  if (commitShaEl) {
    commitShaEl.textContent = summary.integrationCommitSha
      ? summary.integrationCommitSha.slice(0, 10)
      : "-";
    if (summary.integrationCommitSha) commitShaEl.title = summary.integrationCommitSha;
  }

  // REPLAN_REQUIRED banner
  if (replanBanner) {
    if (summary.state === "REPLAN_REQUIRED") {
      replanBanner.classList.remove("hidden");
      if (replanText) {
        replanText.textContent =
          summary.message ||
          "This parallel run encountered integration check or review failure and requires replanning.";
      }
    } else {
      replanBanner.classList.add("hidden");
    }
  }

  // Conflict files banner
  if (conflictsBanner && conflictsList) {
    conflictsList.replaceChildren();
    if (summary.conflictFiles && summary.conflictFiles.length > 0) {
      conflictsBanner.classList.remove("hidden");
      for (const file of summary.conflictFiles) {
        conflictsList.appendChild(el("li", { textContent: file }));
      }
    } else {
      conflictsBanner.classList.add("hidden");
    }
  }
}

/**
 * Render error if status endpoint failed
 */
function renderOverviewError(error) {
  const msgEl = document.getElementById("detail-message");
  const badgeEl = document.getElementById("detail-state-badge");
  if (msgEl) msgEl.textContent = `Failed to load run status: ${error ? error.message : "Unknown error"}`;
  if (badgeEl) {
    badgeEl.textContent = "ERROR";
    badgeEl.className = "badge badge-red";
  }
}

/**
 * Render timeline stage progression and events log
 */
function renderTimeline(currentState, events, isEventsEndpointError) {
  const stagesList = document.getElementById("stages-list");
  const eventsList = document.getElementById("events-list");
  const eventsCount = document.getElementById("events-count");

  const orderedStages = [
    "RECEIVED",
    "PLANNING",
    "SHARDS_RUNNING",
    "INTEGRATING",
    "INTEGRATION_CHECKING",
    "INTEGRATION_REVIEWING",
    "DONE",
  ];

  if (stagesList) {
    const currentIndex = orderedStages.indexOf(currentState);
    const isFailed = currentState === "FAILED" || currentState === "REPLAN_REQUIRED";

    const stageItems = stagesList.querySelectorAll(".stage-step");
    stageItems.forEach((step) => {
      const stageName = step.getAttribute("data-stage");
      const stageIndex = orderedStages.indexOf(stageName);

      step.className = "stage-step";
      if (stageName === currentState) {
        step.classList.add(isFailed ? "failed" : "active");
      } else if (currentIndex >= 0 && stageIndex < currentIndex) {
        step.classList.add("completed");
      }
    });
  }

  if (eventsCount) {
    eventsCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  }

  if (eventsList) {
    eventsList.replaceChildren();

    if (events.length === 0) {
      const emptyMsg = isEventsEndpointError
        ? "Timeline events endpoint not yet available or failed."
        : "No lifecycle events recorded for this run.";
      eventsList.appendChild(
        el("li", { className: "empty-section-message", textContent: emptyMsg })
      );
      return;
    }

    for (const ev of events) {
      const dateStr = ev.at ? new Date(ev.at).toLocaleTimeString() : "-";
      const fullIso = ev.at || "";

      eventsList.appendChild(
        el("li", { className: "event-row" }, [
          el("span", { className: "event-time", textContent: dateStr, title: fullIso }),
          el("span", {
            className: `badge ${getStateBadgeClass(ev.state)}`,
            textContent: ev.state || "-",
          }),
          el("span", { className: "event-message", textContent: ev.message || "-" }),
        ])
      );
    }
  }
}

/**
 * Render worker shards grid
 */
function renderShards(shards) {
  const container = document.getElementById("shards-container");
  const countEl = document.getElementById("shards-count");
  if (!container) return;

  container.replaceChildren();
  if (countEl) countEl.textContent = `${shards.length} shard${shards.length === 1 ? "" : "s"}`;

  if (shards.length === 0) {
    container.appendChild(
      el("div", {
        className: "empty-section-message",
        textContent: "No worker shards planned or running yet for this run.",
      })
    );
    return;
  }

  for (const shard of shards) {
    const isApproved = shard.state === "APPROVED";
    const badgeClass = isApproved ? "badge-green" : "badge-red";

    const shardCard = el("div", { className: "shard-card" }, [
      el("div", { className: "shard-header" }, [
        el("span", { className: "shard-id", textContent: shard.id || "shard" }),
        el("span", { className: `badge ${badgeClass}`, textContent: shard.state || "UNKNOWN" }),
      ]),
      el("div", { className: "shard-meta" }, [
        el("span", {}, ["Branch: ", el("span", { className: "font-mono", textContent: shard.branch || "-" })]),
        el("span", {}, ["Revision: ", el("span", { className: "font-mono", textContent: String(shard.revisionRound ?? 0) })]),
      ]),
      shard.message
        ? el("p", { className: "shard-message", textContent: shard.message })
        : null,
    ]);

    // Changed files
    const changedFiles = shard.changedFiles || [];
    const filesSection = el("div", { className: "shard-files-section" }, [
      el("span", { className: "section-subheading", textContent: `Changed Files (${changedFiles.length})` }),
    ]);

    if (changedFiles.length > 0) {
      const fileTagsList = el("div", { className: "file-tags-list" });
      for (const file of changedFiles) {
        fileTagsList.appendChild(el("span", { className: "file-tag", textContent: file }));
      }
      filesSection.appendChild(fileTagsList);
    } else {
      filesSection.appendChild(
        el("span", { className: "empty-section-message", textContent: "No files changed." })
      );
    }
    shardCard.appendChild(filesSection);

    // Shard checks
    const checks = shard.checks || [];
    const checksSection = el("div", { className: "shard-files-section" }, [
      el("span", { className: "section-subheading", textContent: `Shard Checks (${checks.length})` }),
    ]);

    if (checks.length > 0) {
      const checksList = el("div", { className: "checks-container" });
      for (const ch of checks) {
        const cmdStr = `${ch.command || ""} ${(ch.args || []).join(" ")}`.trim();
        const checkPassed = Boolean(ch.passed);
        checksList.appendChild(
          el("div", { className: "check-item" }, [
            el("div", { className: "check-item-header" }, [
              el("span", { className: "check-command", textContent: cmdStr || "check", title: cmdStr }),
              el("span", {
                className: `badge ${checkPassed ? "badge-green" : "badge-red"}`,
                textContent: checkPassed ? "PASSED" : "FAILED",
              }),
            ]),
            el("div", { className: "check-meta" }, [
              el("span", { textContent: `exit: ${ch.exitCode ?? "-"}` }),
              el("span", { textContent: `${ch.durationMs ?? 0}ms` }),
              ch.timedOut ? el("span", { className: "badge badge-amber", textContent: "TIMED OUT" }) : null,
            ]),
          ])
        );
      }
      checksSection.appendChild(checksList);
    } else {
      checksSection.appendChild(
        el("span", { className: "empty-section-message", textContent: "No checks recorded." })
      );
    }
    shardCard.appendChild(checksSection);

    container.appendChild(shardCard);
  }
}

/**
 * Render integration checks
 */
function renderIntegrationChecks(checksResult) {
  const container = document.getElementById("integration-checks-container");
  const countEl = document.getElementById("checks-count");
  if (!container) return;

  container.replaceChildren();

  if (checksResult.status === "rejected") {
    if (countEl) countEl.textContent = "0 checks";
    container.appendChild(
      el("div", {
        className: "empty-section-message",
        textContent: "Integration checks are pending or not available for this run state.",
      })
    );
    return;
  }

  const checks = checksResult.value || [];
  if (countEl) countEl.textContent = `${checks.length} check${checks.length === 1 ? "" : "s"}`;

  if (checks.length === 0) {
    container.appendChild(
      el("div", {
        className: "empty-section-message",
        textContent: "No integration checks recorded for this run.",
      })
    );
    return;
  }

  for (const ch of checks) {
    const cmdStr = `${ch.command || ""} ${(ch.args || []).join(" ")}`.trim();
    const passed = Boolean(ch.passed);

    container.appendChild(
      el("div", { className: "check-item" }, [
        el("div", { className: "check-item-header" }, [
          el("span", { className: "check-command font-mono", textContent: cmdStr, title: cmdStr }),
          el("span", {
            className: `badge ${passed ? "badge-green" : "badge-red"}`,
            textContent: passed ? "PASSED" : "FAILED",
          }),
        ]),
        el("div", { className: "check-meta" }, [
          el("span", { textContent: `Exit code: ${ch.exitCode ?? "-"}` }),
          el("span", { textContent: `Duration: ${ch.durationMs ?? 0}ms` }),
          ch.timedOut ? el("span", { className: "badge badge-amber", textContent: "TIMED OUT" }) : null,
        ]),
      ])
    );
  }
}

/**
 * Render integration review
 */
function renderIntegrationReview(reviewResult) {
  const container = document.getElementById("integration-review-container");
  const badgeEl = document.getElementById("review-verdict-badge");
  if (!container) return;

  container.replaceChildren();

  if (reviewResult.status === "rejected") {
    if (badgeEl) {
      badgeEl.textContent = "PENDING";
      badgeEl.className = "badge badge-neutral";
    }
    container.appendChild(
      el("div", {
        className: "empty-section-message",
        textContent: "Integration review has not been generated yet for this run.",
      })
    );
    return;
  }

  const review = reviewResult.value;
  const isApproved = review.verdict === "approved";

  if (badgeEl) {
    badgeEl.textContent = (review.verdict || "UNKNOWN").toUpperCase();
    badgeEl.className = `badge ${isApproved ? "badge-green" : "badge-red"}`;
  }

  // Summary box
  container.appendChild(
    el("div", { className: "review-summary-box" }, [
      el("strong", { textContent: "Summary: " }),
      el("span", { textContent: review.summary || "No review summary." }),
    ])
  );

  // Acceptance Criteria
  const criteria = review.acceptance_criteria || [];
  const criteriaSection = el("div", { className: "criteria-section" }, [
    el("span", { className: "section-subheading", textContent: `Acceptance Criteria (${criteria.length})` }),
  ]);

  if (criteria.length > 0) {
    const tbody = el("tbody");
    for (const c of criteria) {
      const isPassed = c.status === "passed";
      const isFailed = c.status === "failed";
      const statusBadgeClass = isPassed ? "badge-green" : isFailed ? "badge-red" : "badge-amber";

      tbody.appendChild(
        el("tr", {}, [
          el("td", { textContent: c.criterion || "-" }),
          el("td", {}, [el("span", { className: `badge ${statusBadgeClass}`, textContent: c.status || "-" })]),
          el("td", { textContent: c.evidence || "-" }),
        ])
      );
    }

    const table = el("table", { className: "criteria-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { textContent: "Criterion" }),
          el("th", { textContent: "Status" }),
          el("th", { textContent: "Evidence" }),
        ]),
      ]),
      tbody,
    ]);
    criteriaSection.appendChild(table);
  } else {
    criteriaSection.appendChild(
      el("div", { className: "empty-section-message", textContent: "No acceptance criteria specified." })
    );
  }
  container.appendChild(criteriaSection);

  // Findings
  const findings = review.findings || [];
  const findingsSection = el("div", { className: "findings-section" }, [
    el("span", { className: "section-subheading", textContent: `Findings (${findings.length})` }),
  ]);

  if (findings.length > 0) {
    const list = el("div", { className: "findings-list" });
    for (const f of findings) {
      const isCritical = f.severity === "critical" || f.severity === "high";
      const badgeClass = isCritical ? "badge-red" : f.severity === "medium" ? "badge-amber" : "badge-neutral";
      const locStr = f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : "";

      list.appendChild(
        el("div", { className: "finding-card" }, [
          el("div", { className: "finding-top" }, [
            el("span", { className: `badge ${badgeClass}`, textContent: (f.severity || "low").toUpperCase() }),
            el("span", { className: "finding-title", textContent: f.title || "Finding" }),
            locStr ? el("span", { className: "finding-location", textContent: locStr }) : null,
          ]),
          el("p", { className: "finding-detail", textContent: f.detail || "-" }),
        ])
      );
    }
    findingsSection.appendChild(list);
  } else {
    findingsSection.appendChild(
      el("div", { className: "empty-section-message", textContent: "No findings reported (clean review)." })
    );
  }
  container.appendChild(findingsSection);
}

/**
 * Render integration diff with line syntax coloring
 */
function renderIntegrationDiff(diffResult) {
  const contentEl = document.getElementById("diff-content");
  const statusBadge = document.getElementById("diff-status-badge");
  const truncBadge = document.getElementById("diff-truncation-badge");
  const metaBar = document.getElementById("diff-meta-bar");
  const copyBtn = document.getElementById("btn-copy-diff");

  if (!contentEl) return;
  contentEl.replaceChildren();

  if (diffResult.status === "rejected") {
    lastSelectedDiffText = "";
    if (statusBadge) {
      statusBadge.textContent = "PENDING";
      statusBadge.className = "badge badge-neutral";
    }
    if (truncBadge) truncBadge.classList.add("hidden");
    if (metaBar) metaBar.classList.add("hidden");
    if (copyBtn) copyBtn.disabled = true;

    contentEl.appendChild(
      el("span", {
        className: "diff-line diff-line-normal",
        textContent: "Integration diff is pending or not available for this run.",
      })
    );
    return;
  }

  const { diff, truncated } = diffResult.value;
  lastSelectedDiffText = diff || "";

  if (statusBadge) {
    statusBadge.textContent = "AVAILABLE";
    statusBadge.className = "badge badge-green";
  }

  if (truncBadge) {
    if (truncated) truncBadge.classList.remove("hidden");
    else truncBadge.classList.add("hidden");
  }

  const lines = (diff || "").split(/\r?\n/);
  if (metaBar) {
    metaBar.classList.remove("hidden");
    metaBar.textContent = `Lines: ${lines.length}${truncated ? " (diff truncated to maximum safety limits)" : ""}`;
  }

  if (copyBtn) copyBtn.disabled = !diff;

  if (!diff || diff.trim().length === 0) {
    contentEl.appendChild(
      el("span", {
        className: "diff-line diff-line-normal",
        textContent: "Empty diff (no uncommitted or committed changes).",
      })
    );
    return;
  }

  for (const line of lines) {
    let lineClass = "diff-line diff-line-normal";
    if (line.startsWith("+++") || line.startsWith("---")) {
      lineClass = "diff-line diff-line-header";
    } else if (line.startsWith("+")) {
      lineClass = "diff-line diff-line-add";
    } else if (line.startsWith("-")) {
      lineClass = "diff-line diff-line-del";
    } else if (line.startsWith("@@")) {
      lineClass = "diff-line diff-line-hunk";
    } else if (line.startsWith("diff ") || line.startsWith("index ")) {
      lineClass = "diff-line diff-line-header";
    }

    contentEl.appendChild(
      el("span", {
        className: lineClass,
        textContent: line,
      })
    );
  }
}

/**
 * Poll /api/parallel-runs and update dashboard
 */
async function pollRuns() {
  if (isPolling) return;
  isPolling = true;

  try {
    const fetchedRuns = await fetchJson(RUNS_API);
    consecutiveFailures = 0;
    updateConnectionStatus("connected");

    runs = Array.isArray(fetchedRuns) ? fetchedRuns : [];
    updateMetricsBar(runs);
    renderSidebarList();

    // Check if initial or preserved run selection should occur
    if (runs.length > 0) {
      if (!selectedRunId || !runs.some((r) => r.id === selectedRunId)) {
        // Read hash if present
        const hashMatch = window.location.hash.match(/^#run-([^&]+)/);
        const hashId = hashMatch ? decodeURIComponent(hashMatch[1]) : null;
        if (hashId && runs.some((r) => r.id === hashId)) {
          selectRun(hashId);
        } else {
          selectRun(runs[0].id);
        }
      } else {
        // Refresh details for currently selected run without losing selection
        fetchAndRenderSelectedRun(selectedRunId);
      }
    } else {
      selectedRunId = null;
      const emptyView = document.getElementById("empty-state");
      const detailView = document.getElementById("run-detail");
      if (emptyView) emptyView.classList.remove("hidden");
      if (detailView) detailView.classList.add("hidden");
    }
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures < 3) {
      updateConnectionStatus("stale", "Retrying connection...");
    } else {
      updateConnectionStatus("disconnected", "API unreachable");
    }
  } finally {
    isPolling = false;
  }
}

/**
 * Copy integration diff to clipboard safely
 */
async function copyDiffToClipboard() {
  const btn = document.getElementById("btn-copy-diff");
  if (!lastSelectedDiffText) return;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(lastSelectedDiffText);
    } else {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = lastSelectedDiffText;
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }

    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = originalText;
      }, 1800);
    }
  } catch (err) {
    if (btn) btn.textContent = "Copy failed";
  }
}

/**
 * Initialize application events and polling loop
 */
function init() {
  const refreshBtn = document.getElementById("btn-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      pollRuns();
    });
  }

  const copyDiffBtn = document.getElementById("btn-copy-diff");
  if (copyDiffBtn) {
    copyDiffBtn.addEventListener("click", copyDiffToClipboard);
  }

  const searchInput = document.getElementById("run-search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      renderSidebarList();
    });
  }

  // Handle URL hash changes
  window.addEventListener("hashchange", () => {
    const hashMatch = window.location.hash.match(/^#run-([^&]+)/);
    if (hashMatch) {
      const newId = decodeURIComponent(hashMatch[1]);
      if (newId !== selectedRunId) {
        selectRun(newId);
      }
    }
  });

  // Initial poll and recurring timer
  pollRuns();
  pollTimer = setInterval(pollRuns, POLL_INTERVAL_MS);
}

// Start application when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
