const REPLY_BUCKETS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  3 * 24 * 60 * 60_000,
];

const REPLY_BUCKET_LABELS = ["<1m", "1-5m", "5-15m", "15-60m", "1-6h", "6-24h", "1-3d", ">3d"];
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "you",
  "are",
  "was",
  "have",
  "just",
  "from",
  "https",
  "http",
  "www",
  "com",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我們",
  "你們",
  "他們",
  "的",
  "了",
  "是",
  "就",
  "也",
  "在",
  "有",
  "很",
  "嗎",
  "啊",
  "吧",
  "啦",
  "喔",
  "欸",
  "嗯",
  "哈哈",
  "可以",
  "不是",
  "一個",
]);

self.addEventListener("message", async ({ data }) => {
  if (data.type !== "analyze") {
    return;
  }

  try {
    const payload = await analyzeFile(data.file);
    self.postMessage({ type: "result", payload });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "未知錯誤",
    });
  }
});

async function analyzeFile(file) {
  const state = createState();
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let preamble = "";
  let foundMessages = false;
  let inString = false;
  let escapeNext = false;
  let depth = 0;
  let currentObject = "";
  let processedMessages = 0;
  let lastProgressSent = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    bytesRead += value.byteLength;
    let text = decoder.decode(value, { stream: true });

    if (!foundMessages) {
      preamble += text;
      const match = preamble.match(/"messages"\s*:\s*\[/);
      if (!match) {
        if (preamble.length > 200_000) {
          throw new Error("找不到 messages 陣列，這似乎不是 Telegram 匯出格式。");
        }
        sendProgress(bytesRead, file.size, processedMessages, "定位 messages 陣列");
        continue;
      }

      const startIndex = match.index + match[0].length;
      text = preamble.slice(startIndex);
      preamble = "";
      foundMessages = true;
    }

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];

      if (depth === 0) {
        if (char === "{") {
          depth = 1;
          currentObject = "{";
          inString = false;
          escapeNext = false;
        } else if (char === "]") {
          break;
        }
        continue;
      }

      currentObject += char;

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{") {
        depth += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          processedMessages += 1;
          processMessageObject(JSON.parse(currentObject), state);
          currentObject = "";
        }
      }
    }

    const progress = (bytesRead / file.size) * 100;
    if (progress - lastProgressSent >= 1 || processedMessages < 10) {
      sendProgress(bytesRead, file.size, processedMessages, "串流解析中");
      lastProgressSent = progress;
    }
  }

  if (!foundMessages) {
    throw new Error("找不到 messages 陣列，無法分析。");
  }

  finalizeState(state);
  return buildPayload(state);
}

function createState() {
  return {
    chatName: "",
    totalMessages: 0,
    textMessages: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    participants: new Map(),
    daily: new Map(),
    monthly: new Map(),
    heatmap: Array.from({ length: 7 }, () => Array(24).fill(0)),
    replyBuckets: Array(REPLY_BUCKET_LABELS.length).fill(0),
    lastMessage: null,
    longestGap: null,
    heavyTerms: new Map(),
  };
}

function processMessageObject(message, state) {
  if (message.type !== "message") {
    return;
  }

  const sender = message.from || "Unknown";
  const timestamp = parseTimestamp(message.date);
  if (!Number.isFinite(timestamp)) {
    return;
  }

  const date = new Date(timestamp);
  const text = extractText(message.text);
  const trimmedText = text.trim();
  const hasText = trimmedText.length > 0;
  const hasMedia = detectMedia(message, hasText);

  state.totalMessages += 1;
  if (hasText) {
    state.textMessages += 1;
  }

  if (state.firstTimestamp === null || timestamp < state.firstTimestamp) {
    state.firstTimestamp = timestamp;
  }
  if (state.lastTimestamp === null || timestamp > state.lastTimestamp) {
    state.lastTimestamp = timestamp;
  }

  const person = getOrCreateParticipant(state.participants, sender);
  person.messages += 1;
  person.characters += trimmedText.length;
  if (hasMedia) {
    person.mediaMessages += 1;
  }

  const dayKey = formatLocalDate(date);
  const monthKey = dayKey.slice(0, 7);
  const dayStats = getOrCreateBucket(state.daily, dayKey);
  const monthStats = getOrCreateBucket(state.monthly, monthKey);
  dayStats.total += 1;
  monthStats.total += 1;
  dayStats.byParticipant[sender] = (dayStats.byParticipant[sender] || 0) + 1;
  monthStats.byParticipant[sender] = (monthStats.byParticipant[sender] || 0) + 1;

  const weekday = (date.getDay() + 6) % 7;
  state.heatmap[weekday][date.getHours()] += 1;

  if (hasText) {
    updateHeavyTerms(state.heavyTerms, trimmedText);
  }

  if (state.lastMessage && state.lastMessage.sender !== sender) {
    const delay = timestamp - state.lastMessage.timestamp;
    if (delay >= 0) {
      addReplyDelay(state, delay);
    }
  }

  if (state.lastMessage) {
    const gap = timestamp - state.lastMessage.timestamp;
    if (
      gap >= 0 &&
      (!state.longestGap || gap > state.longestGap.duration)
    ) {
      state.longestGap = {
        duration: gap,
        from: state.lastMessage.timestamp,
        to: timestamp,
      };
    }
  }

  state.lastMessage = { sender, timestamp };
}

function finalizeState(_state) {}

function buildPayload(state) {
  const participants = [...state.participants.entries()]
    .map(([name, stats]) => ({
      name,
      messages: stats.messages,
      characters: stats.characters,
      avgChars: stats.messages ? stats.characters / stats.messages : 0,
      mediaShare: stats.messages ? ((stats.mediaMessages / stats.messages) * 100).toFixed(1) : "0.0",
    }))
    .sort((left, right) => right.messages - left.messages);

  const dailyEntries = [...state.daily.entries()].map(([date, entry]) => ({
    date,
    total: entry.total,
    byParticipant: entry.byParticipant,
    weekday: formatWeekday(date),
  }));

  const monthlyEntries = [...state.monthly.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, entry]) => ({
      label: month,
      total: entry.total,
      byParticipant: entry.byParticipant,
    }));

  const totalMessages = state.totalMessages || 1;
  const topSender = participants[0]
    ? {
        name: participants[0].name,
        share: ((participants[0].messages / totalMessages) * 100).toFixed(1),
      }
    : null;

  const replyPairs = state.replyBuckets.reduce((sum, count) => sum + count, 0);
  const medianReply = estimateTypicalReply(state.replyBuckets);

  return {
    participants: participants.map((participant) => participant.name),
    summary: {
      totalMessages: state.totalMessages,
      textMessages: state.textMessages,
      activeDays: state.daily.size,
      rangeLabel: buildRangeLabel(state.firstTimestamp, state.lastTimestamp),
      avgPerActiveDay: state.daily.size ? (state.totalMessages / state.daily.size).toFixed(1) : "0",
      topSender,
      medianReplyLabel: medianReply === null ? "N/A" : formatDuration(medianReply),
      replyPairs,
      longestGapLabel: state.longestGap ? formatDuration(state.longestGap.duration) : "N/A",
      longestGapRange: state.longestGap
        ? `${formatShortDate(state.longestGap.from)} → ${formatShortDate(state.longestGap.to)}`
        : "",
    },
    timeline: monthlyEntries,
    heatmap: state.heatmap,
    replyHistogram: {
      bins: REPLY_BUCKET_LABELS.map((label, index) => ({
        label,
        count: state.replyBuckets[index],
      })),
    },
    topDays: dailyEntries
      .sort((left, right) => right.total - left.total)
      .slice(0, 8),
    topTerms: [...state.heavyTerms.entries()]
      .map(([term, count]) => ({ term, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 24),
    people: participants,
  };
}

function parseTimestamp(value) {
  return Date.parse(value);
}

function extractText(input) {
  if (typeof input === "string") {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((chunk) => {
        if (typeof chunk === "string") {
          return chunk;
        }
        if (chunk && typeof chunk.text === "string") {
          return chunk.text;
        }
        return "";
      })
      .join("");
  }

  return "";
}

function detectMedia(message, hasText) {
  const mediaKeys = [
    "photo",
    "file",
    "media_type",
    "thumbnail",
    "sticker_emoji",
    "video_file_size",
    "audio_file_size",
  ];
  return mediaKeys.some((key) => key in message) || !hasText;
}

function getOrCreateParticipant(participants, name) {
  let participant = participants.get(name);
  if (!participant) {
    participant = {
      messages: 0,
      characters: 0,
      mediaMessages: 0,
    };
    participants.set(name, participant);
  }
  return participant;
}

function getOrCreateBucket(map, key) {
  let entry = map.get(key);
  if (!entry) {
    entry = { total: 0, byParticipant: {} };
    map.set(key, entry);
  }
  return entry;
}

function addReplyDelay(state, delay) {
  const bucketIndex = REPLY_BUCKETS_MS.findIndex((limit) => delay < limit);
  const safeIndex = bucketIndex === -1 ? state.replyBuckets.length - 1 : bucketIndex;
  state.replyBuckets[safeIndex] += 1;
}

function updateHeavyTerms(heavyTerms, text) {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const tokens = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  for (const token of tokens) {
    if (STOPWORDS.has(token)) {
      continue;
    }
    if (heavyTerms.has(token)) {
      heavyTerms.set(token, heavyTerms.get(token) + 1);
      continue;
    }
    if (heavyTerms.size < 160) {
      heavyTerms.set(token, 1);
      continue;
    }
    for (const [key, count] of heavyTerms.entries()) {
      if (count <= 1) {
        heavyTerms.delete(key);
      } else {
        heavyTerms.set(key, count - 1);
      }
    }
  }
}

function buildRangeLabel(first, last) {
  if (first === null || last === null) {
    return "N/A";
  }

  const days = Math.max(1, Math.round((last - first) / 86_400_000) + 1);
  if (days >= 365) {
    return `${(days / 365).toFixed(1)} 年`;
  }
  if (days >= 30) {
    return `${(days / 30).toFixed(1)} 月`;
  }
  return `${days} 天`;
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {
    return "<1 分";
  }
  if (minutes < 60) {
    return `${minutes} 分`;
  }
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) {
    return `${hours} 小時`;
  }
  const days = Math.round(ms / 86_400_000);
  if (days < 60) {
    return `${days} 天`;
  }
  return `${(days / 30).toFixed(1)} 月`;
}

function formatShortDate(timestamp) {
  return formatLocalDate(new Date(timestamp));
}

function formatWeekday(dateString) {
  const weekdays = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
  const weekday = (new Date(`${dateString}T00:00:00`).getDay() + 6) % 7;
  return weekdays[weekday];
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function estimateTypicalReply(replyBuckets) {
  const total = replyBuckets.reduce((sum, count) => sum + count, 0);
  if (!total) {
    return null;
  }

  const midpoint = total / 2;
  let seen = 0;
  for (let index = 0; index < replyBuckets.length; index += 1) {
    seen += replyBuckets[index];
    if (seen >= midpoint) {
      return labelToDuration(REPLY_BUCKET_LABELS[index]);
    }
  }
  return null;
}

function labelToDuration(label) {
  switch (label) {
    case "<1m":
      return 30_000;
    case "1-5m":
      return 3 * 60_000;
    case "5-15m":
      return 10 * 60_000;
    case "15-60m":
      return 35 * 60_000;
    case "1-6h":
      return 3.5 * 3_600_000;
    case "6-24h":
      return 15 * 3_600_000;
    case "1-3d":
      return 2 * 86_400_000;
    default:
      return 5 * 86_400_000;
  }
}

function sendProgress(bytesRead, fileSize, processedMessages, label) {
  self.postMessage({
    type: "progress",
    progress: (bytesRead / fileSize) * 100,
    processedMessages,
    label,
  });
}
