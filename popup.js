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
const SUPPORT_DISMISS_UNTIL_KEY = "supportDismissedUntil";
const SUPPORT_DISMISS_COUNT_KEY = "supportDismissCount";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_OUTPUT_TEMPLATE = "<title>";
let latestDisplayedItems = [];

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
  latestDisplayedItems = buildDisplayedResults(parsed);
  renderResults(latestDisplayedItems);
  const statusText = `found ${latestDisplayedItems.length}`;
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
  coffeeWrapEl.classList.remove("is-hidden");
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
    const checkedCount = getCheckedItems().length;
    await downloadCheckedSuno();
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
