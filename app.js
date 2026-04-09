const worker = new Worker("./worker.js", { type: "module" });

const fileInput = document.querySelector("#file-input");
const dropzone = document.querySelector("#dropzone");
const dashboard = document.querySelector("#dashboard");
const statusText = document.querySelector("#status-text");
const progressFill = document.querySelector("#progress-fill");
const progressText = document.querySelector("#progress-text");
const fileMeta = document.querySelector("#file-meta");
const summaryGrid = document.querySelector("#summary-grid");
const timelineChart = document.querySelector("#timeline-chart");
const heatmapChart = document.querySelector("#heatmap-chart");
const replyChart = document.querySelector("#reply-chart");
const daysTable = document.querySelector("#days-table");
const termsCloud = document.querySelector("#terms-cloud");
const peopleTable = document.querySelector("#people-table");
const summaryCardTemplate = document.querySelector("#summary-card-template");
const replyInfoButton = document.querySelector("#reply-info-button");
const replyInfo = document.querySelector("#reply-info");
const chartTooltip = document.querySelector("#chart-tooltip");

let currentFile = null;

replyInfoButton.addEventListener("click", () => {
  const isHidden = replyInfo.classList.toggle("hidden");
  replyInfoButton.setAttribute("aria-expanded", String(!isHidden));
});

fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) {
    handleFile(file);
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (eventName === "drop") {
      const [file] = event.dataTransfer?.files || [];
      if (file) {
        fileInput.files = event.dataTransfer.files;
        handleFile(file);
      }
    }
    dropzone.classList.remove("dragover");
  });
});

worker.addEventListener("message", ({ data }) => {
  if (data.type === "progress") {
    statusText.textContent = data.label;
    setProgress(data.progress);
    if (currentFile) {
      fileMeta.textContent = `${currentFile.name} • ${formatBytes(currentFile.size)} • 已處理 ${data.processedMessages.toLocaleString()} 則訊息`;
    }
    return;
  }

  if (data.type === "result") {
    setProgress(100);
    statusText.textContent = "分析完成";
    renderDashboard(data.payload);
    dashboard.classList.remove("hidden");
    return;
  }

  if (data.type === "error") {
    statusText.textContent = "解析失敗";
    fileMeta.textContent = data.message;
  }
});

function handleFile(file) {
  currentFile = file;
  dashboard.classList.add("hidden");
  summaryGrid.innerHTML = "";
  timelineChart.innerHTML = "";
  heatmapChart.innerHTML = "";
  replyChart.innerHTML = "";
  daysTable.innerHTML = "";
  termsCloud.innerHTML = "";
  peopleTable.innerHTML = "";
  setProgress(0);
  statusText.textContent = "初始化分析";
  fileMeta.textContent = `${file.name} • ${formatBytes(file.size)}`;
  worker.postMessage({ type: "analyze", file });
}

function setProgress(value) {
  const safeValue = Math.max(0, Math.min(100, value));
  progressFill.style.width = `${safeValue}%`;
  progressText.textContent = `${safeValue.toFixed(1)}%`;
}

function renderDashboard(payload) {
  renderSummary(payload.summary);
  renderTimeline(payload.timeline, payload.participants);
  renderHeatmap(payload.heatmap);
  renderReplyHistogram(payload.replyHistogram);
  renderTopDays(payload.topDays);
  renderTerms(payload.topTerms);
  renderPeople(payload.people);
}

function renderSummary(summary) {
  summaryGrid.innerHTML = "";
  const cards = [
    {
      label: "總訊息數",
      value: formatCompact(summary.totalMessages),
      meta: `${summary.textMessages.toLocaleString()} 則含文字內容`,
    },
    {
      label: "時間跨度",
      value: summary.rangeLabel,
      meta: `${summary.activeDays.toLocaleString()} 個活躍日`,
    },
    {
      label: "平均每日",
      value: summary.avgPerActiveDay,
      meta: "以有訊息的日期計算",
    },
    {
      label: "最常發話者",
      value: summary.topSender?.name || "N/A",
      meta: summary.topSender ? `${summary.topSender.share}% 訊息占比` : "找不到參與者資料",
    },
    {
      label: "典型回覆時間",
      value: summary.medianReplyLabel,
      meta: `${summary.replyPairs.toLocaleString()} 次交替回覆`,
    },
    {
      label: "最長沉默",
      value: summary.longestGapLabel,
      meta: summary.longestGapRange || "沒有足夠資料",
    },
  ];

  for (const card of cards) {
    const fragment = summaryCardTemplate.content.cloneNode(true);
    fragment.querySelector(".summary-label").textContent = card.label;
    fragment.querySelector(".summary-value").textContent = card.value;
    fragment.querySelector(".summary-meta").textContent = card.meta;
    summaryGrid.appendChild(fragment);
  }
}

function renderTimeline(timeline, participants) {
  if (!timeline.length) {
    timelineChart.innerHTML = `<div class="empty-state">沒有足夠的月份資料可繪製。</div>`;
    return;
  }

  const width = 980;
  const height = 320;
  const padding = { top: 16, right: 16, bottom: 42, left: 46 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxTotal = Math.max(...timeline.map((entry) => entry.total), 1);
  const barWidth = innerWidth / timeline.length;
  const labelStep = Math.max(1, Math.ceil(timeline.length / 12));
  const colors = ["#1f7a5c", "#c46d2d", "#325c8a", "#874f96"];

  const stackedBars = timeline
    .map((entry, index) => {
      let offset = 0;
      const segments = participants
        .map((name, participantIndex) => {
          const value = entry.byParticipant[name] || 0;
          const segmentHeight = (value / maxTotal) * innerHeight;
          const y = padding.top + innerHeight - offset - segmentHeight;
          offset += segmentHeight;
          const tooltip = `${entry.label}\n${name}: ${value.toLocaleString()} 則\n總計: ${entry.total.toLocaleString()} 則`;
          return `<rect class="has-tooltip" data-tooltip="${escapeAttribute(tooltip)}" x="${padding.left + index * barWidth + 1}" y="${y}" width="${Math.max(barWidth - 2, 1)}" height="${segmentHeight}" fill="${colors[participantIndex % colors.length]}"></rect>`;
        })
        .join("");
      const axisLabel =
        index % labelStep === 0 || index === timeline.length - 1
          ? `<text class="axis-text" x="${padding.left + index * barWidth + barWidth / 2}" y="${height - 18}" text-anchor="middle">${entry.label.slice(2)}</text>`
          : "";
      return `${segments}${axisLabel}`;
    })
    .join("");

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((ratio) => {
      const y = padding.top + innerHeight - innerHeight * ratio;
      const value = Math.round(maxTotal * ratio);
      return `<g><line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(80,62,42,0.12)" /><text class="axis-text" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${value}</text></g>`;
    })
    .join("");

  const legend = participants
    .map(
      (name, index) =>
        `<g transform="translate(${padding.left + index * 180}, ${height - 4})"><rect width="12" height="12" rx="3" fill="${colors[index % colors.length]}"></rect><text class="chart-title" x="18" y="11">${escapeHtml(name)}</text></g>`,
    )
    .join("");

  timelineChart.innerHTML = `<svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="月度訊息趨勢圖">${gridLines}${stackedBars}${legend}</svg>`;
  bindTooltips(timelineChart);
}

function renderHeatmap(heatmap) {
  const days = ["一", "二", "三", "四", "五", "六", "日"];
  const width = 760;
  const height = 340;
  const padding = { top: 22, right: 16, bottom: 26, left: 34 };
  const cellWidth = (width - padding.left - padding.right) / 24;
  const cellHeight = (height - padding.top - padding.bottom) / 7;
  const maxValue = Math.max(...heatmap.flat(), 1);

  const cells = heatmap
    .flatMap((row, dayIndex) =>
      row.map((value, hour) => {
        const x = padding.left + hour * cellWidth;
        const y = padding.top + dayIndex * cellHeight;
        const alpha = value === 0 ? 0.08 : 0.16 + 0.84 * (value / maxValue);
        const tooltip = `週${days[dayIndex]} ${String(hour).padStart(2, "0")}:00-${String((hour + 1) % 24).padStart(2, "0")}:00\n${value.toLocaleString()} 則訊息`;
        return `<rect class="has-tooltip" data-tooltip="${escapeAttribute(tooltip)}" x="${x + 1}" y="${y + 1}" width="${cellWidth - 2}" height="${cellHeight - 2}" rx="6" fill="rgba(31,122,92,${alpha})"></rect>`;
      }),
    )
    .join("");

  const xLabels = Array.from({ length: 24 }, (_, hour) => {
    const x = padding.left + hour * cellWidth + cellWidth / 2;
    return `<text class="axis-text" x="${x}" y="14" text-anchor="middle">${hour}</text>`;
  }).join("");

  const yLabels = days
    .map((day, index) => {
      const y = padding.top + index * cellHeight + cellHeight / 2 + 4;
      return `<text class="axis-text" x="18" y="${y}" text-anchor="middle">${day}</text>`;
    })
    .join("");

  heatmapChart.innerHTML = `<svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="每週時段熱區圖">${xLabels}${yLabels}${cells}</svg>`;
  bindTooltips(heatmapChart);
}

function renderReplyHistogram(histogram) {
  if (!histogram.bins.length) {
    replyChart.innerHTML = `<div class="empty-state">沒有足夠的交替回覆資料。</div>`;
    return;
  }

  const width = 520;
  const height = 280;
  const padding = { top: 20, right: 12, bottom: 42, left: 42 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...histogram.bins.map((bin) => bin.count), 1);
  const barWidth = innerWidth / histogram.bins.length;

  const bars = histogram.bins
    .map((bin, index) => {
      const barHeight = (bin.count / maxValue) * innerHeight;
      const x = padding.left + index * barWidth + 3;
      const y = padding.top + innerHeight - barHeight;
      const tooltip = `${bin.label}\n${bin.count.toLocaleString()} 次交替回覆`;
      return `<g><rect class="has-tooltip" data-tooltip="${escapeAttribute(tooltip)}" x="${x}" y="${y}" width="${Math.max(barWidth - 6, 4)}" height="${barHeight}" rx="8" fill="#c46d2d"></rect><text class="axis-text" x="${x + (barWidth - 6) / 2}" y="${height - 18}" text-anchor="middle">${bin.label}</text></g>`;
    })
    .join("");

  const yLines = [0, 0.5, 1]
    .map((ratio) => {
      const y = padding.top + innerHeight - innerHeight * ratio;
      const label = Math.round(maxValue * ratio);
      return `<g><line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="rgba(80,62,42,0.12)" /><text class="axis-text" x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${label}</text></g>`;
    })
    .join("");

  replyChart.innerHTML = `<svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="回覆速度分布圖">${yLines}${bars}</svg>`;
  bindTooltips(replyChart);
}

function renderTopDays(topDays) {
  if (!topDays.length) {
    daysTable.innerHTML = `<div class="empty-state">沒有可用的日級統計。</div>`;
    return;
  }

  const maxCount = Math.max(...topDays.map((entry) => entry.total), 1);
  daysTable.innerHTML = [
    `<div class="table-row header"><div>日期</div><div>總訊息</div><div>雙方分布</div><div>密度</div></div>`,
    ...topDays.map((entry) => {
      const participants = Object.entries(entry.byParticipant)
        .map(([name, count]) => `${escapeHtml(name)} ${count}`)
        .join(" / ");
      const tooltip = `${entry.date} ${entry.weekday}\n總訊息: ${entry.total.toLocaleString()} 則\n${Object.entries(entry.byParticipant)
        .map(([name, count]) => `${name}: ${count.toLocaleString()} 則`)
        .join("\n")}`;
      return `<div class="table-row has-tooltip" data-tooltip="${escapeAttribute(tooltip)}"><div class="table-cell"><strong>${entry.date}</strong><span class="table-muted">${entry.weekday}</span></div><div class="table-cell"><strong>${entry.total.toLocaleString()}</strong></div><div class="table-cell">${participants}</div><div class="table-cell"><div class="mini-bar"><span style="width:${(entry.total / maxCount) * 100}%"></span></div></div></div>`;
    }),
  ].join("");
  bindTooltips(daysTable);
}

function renderTerms(topTerms) {
  if (!topTerms.length) {
    termsCloud.innerHTML = `<div class="empty-state">文字訊息太少，無法產生熱門詞。</div>`;
    return;
  }

  const maxCount = Math.max(...topTerms.map((term) => term.count), 1);
  termsCloud.innerHTML = topTerms
    .map((term) => {
      const emphasis = 0.9 + (term.count / maxCount) * 0.7;
      return `<span class="term-chip has-tooltip" data-tooltip="${escapeAttribute(`${term.term}\n約出現 ${term.count.toLocaleString()} 次`)}" style="font-size:${emphasis}rem"><strong>${escapeHtml(term.term)}</strong>${term.count}</span>`;
    })
    .join("");
  bindTooltips(termsCloud);
}

function renderPeople(people) {
  if (!people.length) {
    peopleTable.innerHTML = `<div class="empty-state">沒有參與者統計。</div>`;
    return;
  }

  const maxMessages = Math.max(...people.map((person) => person.messages), 1);
  peopleTable.innerHTML = [
    `<div class="table-row header"><div>參與者</div><div>訊息數</div><div>平均字數</div><div>媒體訊息占比</div></div>`,
    ...people.map((person) => {
      const share = ((person.messages / maxMessages) * 100).toFixed(1);
      const tooltip = `${person.name}\n訊息數: ${person.messages.toLocaleString()} 則\n總字元: ${person.characters.toLocaleString()}\n平均字數: ${person.avgChars.toFixed(1)}\n媒體訊息占比: ${person.mediaShare}%`;
      return `<div class="table-row has-tooltip" data-tooltip="${escapeAttribute(tooltip)}"><div class="table-cell"><strong>${escapeHtml(person.name)}</strong><span class="table-muted">${person.characters.toLocaleString()} 字元</span></div><div class="table-cell"><strong>${person.messages.toLocaleString()}</strong><div class="mini-bar"><span style="width:${share}%"></span></div></div><div class="table-cell">${person.avgChars.toFixed(1)}</div><div class="table-cell">${person.mediaShare}%</div></div>`;
    }),
  ].join("");
  bindTooltips(peopleTable);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatCompact(value) {
  return new Intl.NumberFormat("zh-Hant", {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function escapeHtml(input) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(input) {
  return escapeHtml(input).replaceAll('"', "&quot;");
}

function bindTooltips(container) {
  const elements = container.querySelectorAll("[data-tooltip]");
  for (const element of elements) {
    element.addEventListener("mouseenter", showTooltip);
    element.addEventListener("mousemove", moveTooltip);
    element.addEventListener("mouseleave", hideTooltip);
  }
}

function showTooltip(event) {
  const message = event.currentTarget.getAttribute("data-tooltip");
  if (!message) {
    return;
  }
  chartTooltip.textContent = message;
  chartTooltip.classList.remove("hidden");
  moveTooltip(event);
}

function moveTooltip(event) {
  const offset = 14;
  const tooltipWidth = chartTooltip.offsetWidth || 220;
  const tooltipHeight = chartTooltip.offsetHeight || 60;
  let left = event.clientX + offset;
  let top = event.clientY + offset;

  if (left + tooltipWidth > window.innerWidth - 12) {
    left = event.clientX - tooltipWidth - offset;
  }
  if (top + tooltipHeight > window.innerHeight - 12) {
    top = event.clientY - tooltipHeight - offset;
  }

  chartTooltip.style.left = `${Math.max(12, left)}px`;
  chartTooltip.style.top = `${Math.max(12, top)}px`;
}

function hideTooltip() {
  chartTooltip.classList.add("hidden");
}
