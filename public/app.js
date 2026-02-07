const form = document.querySelector("#timeline-form");
const statusEl = document.querySelector("#status");
const timelineEl = document.querySelector("#timeline");
const metricsEl = document.querySelector("#metrics");
const button = document.querySelector("#load-button");

function fmtDate(dateIso) {
  const date = new Date(dateIso);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function renderMetrics(data) {
  metricsEl.innerHTML = "";

  const metrics = [
    `Last ${data.window?.days || 30} days`,
    `${data.milestones.length} milestones`,
    `${data.totals.saleCount} sale events`,
    `${data.totals.soldCreatedCount || 0} sold (created)`,
    `${data.totals.soldBoughtCount || 0} sold (bought)`
  ];

  for (const label of metrics) {
    const node = document.createElement("div");
    node.className = "metric";
    node.textContent = label;
    metricsEl.appendChild(node);
  }
}

function renderTimeline(milestones) {
  timelineEl.innerHTML = "";

  if (!milestones.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No matching events were found for this wallet/contracts selection.";
    timelineEl.appendChild(empty);
    return;
  }

  milestones.forEach((milestone, idx) => {
    const node = document.createElement("article");
    node.className = "milestone";
    node.style.animationDelay = `${idx * 45}ms`;

    node.innerHTML = `
      <div class="dot" aria-hidden="true"></div>
      <div class="card">
        <time>${fmtDate(milestone.date)}</time>
        <h3>${milestone.title}</h3>
        <p>${milestone.detail}</p>
      </div>
    `;

    timelineEl.appendChild(node);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const artist = document.querySelector("#artist").value.trim() || "Artist";
  const wallet = document.querySelector("#wallet").value.trim();
  const contracts = document.querySelector("#contracts").value.trim();
  const chain = document.querySelector("#chain").value.trim() || "ethereum";

  if (!wallet && !contracts) {
    statusEl.textContent = "Enter a wallet/ENS or at least one contract address.";
    return;
  }

  button.disabled = true;
  statusEl.textContent = "Loading 30-day blockchain milestones...";

  try {
    const query = new URLSearchParams({ artist, chain });
    if (wallet) query.set("wallet", wallet);
    if (contracts) query.set("contracts", contracts);
    const response = await fetch(`/api/timeline?${query}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load timeline");
    }

    statusEl.textContent = `Timeline ready for ${data.artist}.`;
    renderMetrics(data);
    renderTimeline(data.milestones);
  } catch (error) {
    timelineEl.innerHTML = "";
    metricsEl.innerHTML = "";
    statusEl.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
