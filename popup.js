const regexInput = document.getElementById("regexInput");
const regexResetBtn = document.getElementById("regexResetBtn");
const scanBtn = document.getElementById("scanBtn");
const downloadCheckedBtn = document.getElementById("downloadCheckedBtn");
const toggleAllBtn = document.getElementById("toggleAllBtn");
const outputTemplateInput = document.getElementById("outputTemplateInput");
const statusEl = document.getElementById("status");
const resultsListEl = document.getElementById("resultsList");
const coffeeWrapEl = document.getElementById("coffeeWrap");
const coffeeDismissBtn = document.getElementById("coffeeDismissBtn");

const STORAGE_KEY = "scanState";
const MEMORY_KEY = "sunoDlMemory";
const SUPPORT_DISMISS_UNTIL_KEY = "supportDismissedUntil";
const SUPPORT_DISMISS_COUNT_KEY = "supportDismissCount";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_OUTPUT_TEMPLATE = "<title>";
let latestDisplayedItems = [];
let currentPageKey = "";
let coffeeDismissNeedsConfirm = false;
const COFFEE_DISMISS_ARIA_DEFAULT = "Dismiss support message";
const COFFEE_DISMISS_ARIA_CONFIRM = "Click again to dismiss";

function getRegex() {
  const source = regexInput.value.trim();
  if (!source) {
    throw new Error("Regex is empty.");
  }
  return new RegExp(source, "gi");
}

function parseSunoAnchors(text, regex) {
  const byUuid = new Map();
  let match = regex.exec(text);

  while (match !== null) {
    const uuid = (match[1] || "").trim();
    const title = (match[2] || "").trim();
    if (uuid && title && !byUuid.has(uuid)) {
      byUuid.set(uuid, { uuid, title });
    }
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }
    match = regex.exec(text);
  }

  return Array.from(byUuid.values());
}

function toSunoUrl(uuid) {
  return `https://cdn1.suno.ai/${uuid}.mp3`;
}

function sanitizeFilePart(value) {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

function buildDisplayedResults(matches) {
  return matches.map((item) => {
    const url = toSunoUrl(item.uuid);
    return {
      uuid: item.uuid,
      title: item.title,
      value: url,
      display: `${item.title} -> ${url}`
    };
  });
}

/**
 * Suno virtualizes its lists: rows scrolled out of view are removed from the DOM,
 * so a single scan only ever sees the current window of songs. Scans on the same
 * page are merged into one growing list instead of replacing it.
 */
function toPageKey(url) {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch (error) {
    return url;
  }
}

function mergeDisplayedResults(existing, incoming) {
  const byUuid = new Map(existing.map((item) => [item.uuid, item]));
  const added = [];

  for (const item of incoming) {
    const known = byUuid.get(item.uuid);
    if (!known) {
      byUuid.set(item.uuid, item);
      added.push(item);
      continue;
    }
    if (item.title && item.title !== known.title) {
      byUuid.set(item.uuid, item);
    }
  }

  return { items: Array.from(byUuid.values()), added };
}

function getOutputTemplate() {
  const value = outputTemplateInput.value.trim();
  return value || DEFAULT_OUTPUT_TEMPLATE;
}

function buildOutputFilename(item) {
  const raw = getOutputTemplate()
    .replace(/<title>/gi, item.title || "untitled")
    .replace(/<uuid>/gi, item.uuid || "");
  const safe = sanitizeFilePart(raw) || "untitled";
  return safe.toLowerCase().endsWith(".mp3") ? safe : `${safe}.mp3`;
}

function getAllResultCheckboxes() {
  return Array.from(resultsListEl.querySelectorAll(".result-check"));
}

function getCheckedUuids() {
  return getAllResultCheckboxes()
    .filter((box) => box.checked)
    .map((box) => box.dataset.uuid)
    .filter(Boolean);
}

function getCheckedItems() {
  const checkedSet = new Set(getCheckedUuids());
  return latestDisplayedItems.filter((item) => checkedSet.has(item.uuid));
}

function areAllChecked() {
  const boxes = getAllResultCheckboxes();
  return boxes.length > 0 && boxes.every((box) => box.checked);
}

function updateToggleAllButtonState() {
  const boxes = getAllResultCheckboxes();
  if (!boxes.length) {
    toggleAllBtn.disabled = true;
    toggleAllBtn.textContent = "Select all";
    return;
  }
  toggleAllBtn.disabled = false;
  toggleAllBtn.textContent = areAllChecked() ? "Clear" : "Select all";
}

function updateDownloadCheckedButtonState() {
  downloadCheckedBtn.disabled = getCheckedItems().length === 0;
  updateToggleAllButtonState();
}

async function getMemory() {
  const store = await browser.storage.local.get(MEMORY_KEY);
  const raw = store[MEMORY_KEY];
  return {
    downloaded: new Set(Array.isArray(raw?.downloaded) ? raw.downloaded : []),
    lastScan: new Set(Array.isArray(raw?.lastScan) ? raw.lastScan : [])
  };
}

async function saveMemory(mem) {
  await browser.storage.local.set({
    [MEMORY_KEY]: {
      downloaded: [...mem.downloaded],
      lastScan: [...mem.lastScan]
    }
  });
}

/**
 * Auto-select rules:
 * - Never pre-check items already downloaded.
 * - Same page as last scan (same uuid set) but some not downloaded yet → check only undownloaded.
 * - Otherwise treat as new/changed page: check items that were not in the last scan snapshot.
 */
function buildSmartCheckedSet(items, mem) {
  const checked = new Set();
  if (!items.length) {
    return checked;
  }

  const allSeenOnLastScan =
    items.length > 0 && items.every((item) => mem.lastScan.has(item.uuid));
  const someUndownloaded = items.some((item) => !mem.downloaded.has(item.uuid));

  if (allSeenOnLastScan && someUndownloaded) {
    for (const item of items) {
      if (!mem.downloaded.has(item.uuid)) {
        checked.add(item.uuid);
      }
    }
    return checked;
  }

  for (const item of items) {
    if (!mem.downloaded.has(item.uuid) && !mem.lastScan.has(item.uuid)) {
      checked.add(item.uuid);
    }
  }
  return checked;
}

function formatScanStatus(foundCount, checkedCount, addedCount = null) {
  if (foundCount === 0) {
    return "found 0";
  }
  const found = addedCount === null ? `found ${foundCount}` : `found ${foundCount} (+${addedCount})`;
  if (checkedCount === foundCount) {
    return found;
  }
  if (checkedCount === 0) {
    return `${found} · none new (Select all for full list)`;
  }
  return `${found} · ${checkedCount} new selected`;
}

function renderResults(items, checkedUuidSet = null) {
  resultsListEl.innerHTML = "";
  if (!items.length) {
    resultsListEl.textContent = "No results.";
    updateDownloadCheckedButtonState();
    return;
  }

  for (const item of items) {
    const row = document.createElement("label");
    row.className = "result-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "result-check";
    checkbox.dataset.uuid = item.uuid;
    checkbox.checked = checkedUuidSet ? checkedUuidSet.has(item.uuid) : true;
    checkbox.addEventListener("change", async () => {
      updateDownloadCheckedButtonState();
      await persistState(statusEl.textContent);
    });

    const text = document.createElement("span");
    text.className = "result-text";
    text.textContent = item.display;

    row.appendChild(checkbox);
    row.appendChild(text);
    resultsListEl.appendChild(row);
  }
  updateDownloadCheckedButtonState();
}

async function persistState(statusText) {
  await browser.storage.local.set({
    [STORAGE_KEY]: {
      regex: regexInput.value,
      outputTemplate: outputTemplateInput.value,
      status: statusText,
      pageKey: currentPageKey,
      items: latestDisplayedItems,
      checkedUuids: getCheckedUuids()
    }
  });
}

async function restoreState() {
  const store = await browser.storage.local.get(STORAGE_KEY);
  const saved = store[STORAGE_KEY];
  if (!saved) {
    return;
  }

  if (saved.regex) {
    regexInput.value = saved.regex;
  }
  outputTemplateInput.value = saved.outputTemplate || DEFAULT_OUTPUT_TEMPLATE;
  currentPageKey = typeof saved.pageKey === "string" ? saved.pageKey : "";
  latestDisplayedItems = Array.isArray(saved.items) ? saved.items : [];
  const checkedSet = new Set(Array.isArray(saved.checkedUuids) ? saved.checkedUuids : []);
  renderResults(latestDisplayedItems, checkedSet);
  statusEl.textContent = saved.status || "Restored previous scan.";
}

async function scanActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error("No active tab found.");
  }

  const [html] = await browser.tabs.executeScript(tab.id, {
    code: "document.documentElement ? document.documentElement.outerHTML : '';"
  });

  const regex = getRegex();
  const parsed = parseSunoAnchors(html || "", regex);
  const scanned = buildDisplayedResults(parsed);

  const pageKey = toPageKey(tab.url);
  const samePage = Boolean(pageKey) && pageKey === currentPageKey;
  const mem = await getMemory();

  let checkedSet;
  let addedCount = null;

  if (samePage) {
    // Keep everything already collected on this page plus whatever the user
    // checked, and only auto-select the rows this scan revealed for the first time.
    const previouslyChecked = new Set(getCheckedUuids());
    const { items, added } = mergeDisplayedResults(latestDisplayedItems, scanned);
    latestDisplayedItems = items;
    addedCount = added.length;
    checkedSet = previouslyChecked;
    for (const uuid of buildSmartCheckedSet(added, mem)) {
      checkedSet.add(uuid);
    }
  } else {
    latestDisplayedItems = scanned;
    checkedSet = buildSmartCheckedSet(latestDisplayedItems, mem);
  }

  currentPageKey = pageKey;
  renderResults(latestDisplayedItems, checkedSet);

  mem.lastScan = new Set(latestDisplayedItems.map((item) => item.uuid));
  await saveMemory(mem);

  const statusText = formatScanStatus(latestDisplayedItems.length, checkedSet.size, addedCount);
  statusEl.textContent = statusText;
  await persistState(statusText);
}

async function isSupportDismissedActive() {
  const store = await browser.storage.local.get(SUPPORT_DISMISS_UNTIL_KEY);
  const until = store[SUPPORT_DISMISS_UNTIL_KEY];
  return typeof until === "number" && Date.now() < until;
}

async function showCoffeeWrapIfAllowed() {
  if (!coffeeWrapEl || (await isSupportDismissedActive())) {
    return;
  }
  const wasHidden = coffeeWrapEl.classList.contains("is-hidden");
  coffeeWrapEl.classList.remove("is-hidden");
  if (wasHidden && coffeeDismissBtn) {
    coffeeDismissNeedsConfirm = false;
    coffeeDismissBtn.removeAttribute("title");
    coffeeDismissBtn.setAttribute("aria-label", COFFEE_DISMISS_ARIA_DEFAULT);
  }
}

async function downloadCheckedSuno() {
  const items = getCheckedItems();
  for (const item of items) {
    await browser.downloads.download({
      url: item.value,
      filename: buildOutputFilename(item),
      saveAs: false
    });
  }
}

if (regexResetBtn && regexInput) {
  regexResetBtn.addEventListener("click", async () => {
    regexInput.value = regexInput.defaultValue;
    await persistState(statusEl.textContent);
  });
}

scanBtn.addEventListener("click", async () => {
  statusEl.textContent = "Scanning active tab...";
  try {
    await scanActiveTab();
  } catch (error) {
    latestDisplayedItems = [];
    currentPageKey = "";
    resultsListEl.textContent = "";
    updateDownloadCheckedButtonState();
    const statusText = `Error: ${error.message}`;
    statusEl.textContent = statusText;
    await persistState(statusText);
  }
});

downloadCheckedBtn.addEventListener("click", async () => {
  await showCoffeeWrapIfAllowed();
  try {
    const queued = getCheckedItems();
    const checkedCount = queued.length;
    await downloadCheckedSuno();
    const mem = await getMemory();
    for (const item of queued) {
      mem.downloaded.add(item.uuid);
    }
    await saveMemory(mem);

    const statusText = `Download queued for ${checkedCount} item(s).`;
    statusEl.textContent = statusText;
    await persistState(statusText);
  } catch (error) {
    statusEl.textContent = `Download checked failed: ${error.message}`;
  }
});

toggleAllBtn.addEventListener("click", async () => {
  const boxes = getAllResultCheckboxes();
  if (!boxes.length) {
    return;
  }

  const targetChecked = !areAllChecked();
  for (const box of boxes) {
    box.checked = targetChecked;
  }
  updateDownloadCheckedButtonState();
  await persistState(statusEl.textContent);
});

outputTemplateInput.addEventListener("input", async () => {
  await persistState(statusEl.textContent);
});

if (coffeeDismissBtn && coffeeWrapEl) {
  coffeeDismissBtn.addEventListener("click", async () => {
    if (!coffeeDismissNeedsConfirm) {
      coffeeDismissNeedsConfirm = true;
      coffeeDismissBtn.title = COFFEE_DISMISS_ARIA_CONFIRM;
      coffeeDismissBtn.setAttribute("aria-label", COFFEE_DISMISS_ARIA_CONFIRM);
      return;
    }

    coffeeDismissNeedsConfirm = false;
    coffeeDismissBtn.removeAttribute("title");
    coffeeDismissBtn.setAttribute("aria-label", COFFEE_DISMISS_ARIA_DEFAULT);
    coffeeWrapEl.classList.add("is-hidden");
    const store = await browser.storage.local.get(SUPPORT_DISMISS_COUNT_KEY);
    const prevCount = Number(store[SUPPORT_DISMISS_COUNT_KEY]) || 0;
    const nextCount = prevCount + 1;
    const hideMs = nextCount >= 2 ? SEVEN_DAYS_MS : TWO_DAYS_MS;
    await browser.storage.local.set({
      [SUPPORT_DISMISS_UNTIL_KEY]: Date.now() + hideMs,
      [SUPPORT_DISMISS_COUNT_KEY]: nextCount
    });
  });
}

restoreState()
  .catch(() => {
    statusEl.textContent = "No previous scan restored.";
  })
  .finally(() => {
    if (!outputTemplateInput.value) {
      outputTemplateInput.value = DEFAULT_OUTPUT_TEMPLATE;
    }
    updateDownloadCheckedButtonState();
    if (!latestDisplayedItems.length) {
      resultsListEl.textContent = "No results.";
    }
  });
