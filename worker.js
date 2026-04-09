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
const PHRASE_STOPWORDS = new Set(["哈哈", "晚安", "早安", "貼圖", "圖片"]);
const MESSAGE_TYPE_LABELS = {
  text: "文字",
  photo: "圖片",
  sticker: "貼圖",
  video: "影片",
  voice: "語音",
  audio: "音訊",
  animation: "GIF/動畫",
  file: "檔案",
  other: "其他",
};

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
    calls: [],
    lastMessage: null,
    longestGap: null,
    heavyTerms: new Map(),
    catchphraseStats: new Map(),
  };
}

function processMessageObject(message, state) {
  const sender = resolveSender(message);
  const timestamp = parseTimestamp(message.date);
  if (!Number.isFinite(timestamp)) {
    return;
  }

  if (isPhoneCallEvent(message)) {
    processPhoneCall(message, state, sender, timestamp);
    return;
  }

  if (message.type !== "message") {
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
  incrementMessageType(person.messageTypes, classifyMessageType(message, hasText));

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
    updateParticipantLanguage(state.catchphraseStats, sender, trimmedText);
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

function resolveSender(message) {
  const candidates = [
    message.from,
    message.actor,
    message.member_id,
    message.from_id,
    message.actor_id,
    message.user_id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "Unknown";
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
    dailyTimeline: dailyEntries
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((entry) => ({
        label: entry.date,
        total: entry.total,
        byParticipant: entry.byParticipant,
      })),
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
    catchphrases: buildCatchphrasePayload(state.catchphraseStats, state.totalMessages),
    messageMix: buildMessageMixPayload(participants, state.participants),
    calls: buildCallsPayload(state.calls),
    people: participants,
  };
}

function isPhoneCallEvent(message) {
  return message.action === "phone_call" || message.type === "phone_call";
}

function processPhoneCall(message, state, sender, timestamp) {
  state.calls.push({
    sender,
    timestamp,
    durationSeconds: extractCallDurationSeconds(message),
    outcome: getCallOutcomeLabel(message),
  });
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

function classifyMessageType(message, hasText) {
  if ("sticker_emoji" in message) {
    return "sticker";
  }
  if ("photo" in message) {
    return "photo";
  }
  if (message.media_type === "video_file" || "video_file_size" in message) {
    return "video";
  }
  if (message.media_type === "voice_message") {
    return "voice";
  }
  if (message.media_type === "audio_file" || "audio_file_size" in message) {
    return "audio";
  }
  if (message.media_type === "animation") {
    return "animation";
  }
  if ("file" in message || message.media_type === "document") {
    return "file";
  }
  if (hasText) {
    return "text";
  }
  return "other";
}

function getOrCreateParticipant(participants, name) {
  let participant = participants.get(name);
  if (!participant) {
    participant = {
      messages: 0,
      characters: 0,
      mediaMessages: 0,
      messageTypes: new Map(),
    };
    participants.set(name, participant);
  }
  return participant;
}

function incrementMessageType(messageTypes, type) {
  messageTypes.set(type, (messageTypes.get(type) || 0) + 1);
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
  const tokens = extractTermTokens(text);
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

function updateParticipantLanguage(catchphraseStats, sender, text) {
  let person = catchphraseStats.get(sender);
  if (!person) {
    person = {
      words: new Map(),
      phrases: new Map(),
      messages: 0,
    };
    catchphraseStats.set(sender, person);
  }

  person.messages += 1;

  for (const token of extractTermTokens(text)) {
    if (STOPWORDS.has(token)) {
      continue;
    }
    incrementHeavyHitters(person.words, token, 96);
  }

  for (const phrase of extractPhraseCandidates(text)) {
    incrementHeavyHitters(person.phrases, phrase, 64);
  }
}

function extractTermTokens(text) {
  const normalized = text.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
  const tokens = normalized.match(/[a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) || [];
  const output = [];

  for (const token of tokens) {
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      if (token.length <= 4) {
        output.push(token);
        continue;
      }

      for (let index = 0; index < token.length - 1; index += 1) {
        output.push(token.slice(index, index + 2));
      }
      continue;
    }

    output.push(token);
  }

  return output;
}

function extractPhraseCandidates(text) {
  const normalized = text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[~!！?？,，.。:：;；、/\n\r\t]+/g, "|")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const seen = new Set();
  const phrases = [];
  for (const rawPart of normalized.split("|")) {
    const candidate = rawPart.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!candidate || candidate.length < 2 || candidate.length > 12) {
      continue;
    }
    if (/^\d+$/u.test(candidate) || PHRASE_STOPWORDS.has(candidate)) {
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    phrases.push(candidate);
  }
  return phrases;
}

function incrementHeavyHitters(map, key, limit) {
  if (map.has(key)) {
    map.set(key, map.get(key) + 1);
    return;
  }
  if (map.size < limit) {
    map.set(key, 1);
    return;
  }
  for (const [entry, count] of map.entries()) {
    if (count <= 1) {
      map.delete(entry);
    } else {
      map.set(entry, count - 1);
    }
  }
}

function buildCatchphrasePayload(catchphraseStats, totalMessages) {
  return [...catchphraseStats.entries()]
    .map(([name, stats]) => ({
      name,
      messageShare: totalMessages ? ((stats.messages / totalMessages) * 100).toFixed(1) : "0.0",
      topWords: [...stats.words.entries()]
        .map(([term, count]) => ({ term, count }))
        .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term))
        .slice(0, 8),
      topPhrases: [...stats.phrases.entries()]
        .filter(([, count]) => count >= 2)
        .map(([term, count]) => ({ term, count }))
        .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term))
        .slice(0, 6),
      messages: stats.messages,
    }))
    .sort((left, right) => right.messages - left.messages)
    .map(({ messages: _messages, ...person }) => person);
}

function buildMessageMixPayload(participants, participantMap) {
  return participants.map((person) => {
    const source = participantMap.get(person.name);
    const total = person.messages || 1;
    const categories = Object.entries(MESSAGE_TYPE_LABELS)
      .map(([key, label]) => {
        const count = source?.messageTypes.get(key) || 0;
        return {
          key,
          label,
          count,
          share: ((count / total) * 100).toFixed(1),
        };
      })
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count);

    return {
      name: person.name,
      total: person.messages,
      categories,
    };
  });
}

function buildCallsPayload(calls) {
  if (!calls.length) {
    return {
      total: 0,
      connected: 0,
      totalDurationLabel: "0 分",
      avgDurationLabel: "0 分",
      byParticipant: [],
      byMonth: [],
      byHour: [],
      outcomes: [],
      topCaller: null,
      topHour: null,
    };
  }

  const byParticipant = new Map();
  const byMonth = new Map();
  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    label: `${String(hour).padStart(2, "0")}:00`,
    count: 0,
  }));
  const outcomes = new Map();
  let connected = 0;
  let totalDurationSeconds = 0;

  for (const call of calls) {
    const date = new Date(call.timestamp);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const hour = date.getHours();
    const participant = byParticipant.get(call.sender) || { name: call.sender, count: 0, durationSeconds: 0 };

    participant.count += 1;
    participant.durationSeconds += call.durationSeconds;
    byParticipant.set(call.sender, participant);

    const month = byMonth.get(monthKey) || { label: monthKey, count: 0, durationSeconds: 0 };
    month.count += 1;
    month.durationSeconds += call.durationSeconds;
    byMonth.set(monthKey, month);

    byHour[hour].count += 1;
    outcomes.set(call.outcome, (outcomes.get(call.outcome) || 0) + 1);

    if (call.durationSeconds > 0) {
      connected += 1;
      totalDurationSeconds += call.durationSeconds;
    }
  }

  const total = calls.length;
  const topCallerEntry = [...byParticipant.values()].sort((left, right) => right.count - left.count)[0] || null;
  const topHourEntry = [...byHour].sort((left, right) => right.count - left.count)[0] || null;

  return {
    total,
    connected,
    totalDurationLabel: formatCallDuration(totalDurationSeconds),
    avgDurationLabel: formatCallDuration(connected ? Math.round(totalDurationSeconds / connected) : 0),
    byParticipant: [...byParticipant.values()]
      .sort((left, right) => right.count - left.count)
      .map((entry) => ({
        ...entry,
        share: ((entry.count / total) * 100).toFixed(1),
        durationLabel: formatCallDuration(entry.durationSeconds),
      })),
    byMonth: [...byMonth.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((entry) => ({
        ...entry,
        share: ((entry.count / total) * 100).toFixed(1),
        durationLabel: formatCallDuration(entry.durationSeconds),
      })),
    byHour: byHour
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count)
      .slice(0, 8)
      .map((entry) => ({
        ...entry,
        share: ((entry.count / total) * 100).toFixed(1),
      })),
    outcomes: [...outcomes.entries()]
      .map(([label, count]) => ({
        label,
        count,
        share: ((count / total) * 100).toFixed(1),
      }))
      .sort((left, right) => right.count - left.count),
    topCaller: topCallerEntry
      ? {
          name: topCallerEntry.name,
          share: ((topCallerEntry.count / total) * 100).toFixed(1),
        }
      : null,
    topHour: topHourEntry
      ? {
          label: topHourEntry.label,
          count: topHourEntry.count,
        }
      : null,
  };
}

function extractCallDurationSeconds(message) {
  const duration = Number(message.duration_seconds ?? message.duration ?? 0);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function getCallOutcomeLabel(message) {
  const reason = String(message.discard_reason || message.reason || "").toLowerCase();
  if (!reason) {
    return extractCallDurationSeconds(message) > 0 ? "已接通" : "未知結果";
  }
  if (reason.includes("miss")) {
    return "未接";
  }
  if (reason.includes("disconnect") || reason.includes("hangup")) {
    return "主動掛斷";
  }
  if (reason.includes("busy")) {
    return "忙線";
  }
  if (reason.includes("declin")) {
    return "已拒接";
  }
  if (reason.includes("cancel")) {
    return "已取消";
  }
  return reason;
}

function formatCallDuration(totalSeconds) {
  if (!totalSeconds) {
    return "0 分";
  }
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes ? `${hours} 小時 ${remainMinutes} 分` : `${hours} 小時`;
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
