import "./style.css";

const CLIENT_VERSION = "2026-02-22-1";
console.info("Echochan client", CLIENT_VERSION);
import { createClient } from "@supabase/supabase-js";

const DEFAULT_SUPABASE_URL = "https://nuildqmtkmzcwkgfnqki.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "sb_publishable_QEjAIv_oVtq7M73mnTRqOA_kGM8tKhr";
const MAX_ATTACHMENT_COUNT = 2;

const el = (id) => document.getElementById(id);

const state = {
  settings: null,
  currentRoom: "#test",
  rooms: [],
  roomCounts: {},
  attachments: [],
  maxImageKB: 300,
  maxPayloadKB: 6000,
  lastMessageId: new Map(),
  lastCreatedAtByRoom: new Map(),
  replyTo: null,
  isAtBottom: true,
  isSending: false
};

const messagesByRoom = new Map();
const seenIds = new Set();
const messageIndex = new Map();
let supabaseClient = null;
let supabaseChannel = null;
let pollTimer = null;
let pollRoom = null;

function getSupabaseConfig() {
  const url =
    (state.settings?.supabase_url || "").trim() || DEFAULT_SUPABASE_URL;
  const key =
    (state.settings?.supabase_anon_key || "").trim() || DEFAULT_SUPABASE_ANON_KEY;
  return { url, key };
}

function useSupabase() {
  const { url, key } = getSupabaseConfig();
  return Boolean(url && key);
}

function getSupabaseClient() {
  if (!useSupabase()) return null;
  if (!supabaseClient) {
    const { url, key } = getSupabaseConfig();
    supabaseClient = createClient(url, key, {
      auth: { persistSession: false }
    });
  }
  return supabaseClient;
}

function resetSupabaseChannel() {
  const client = getSupabaseClient();
  if (!client || !supabaseChannel) return;
  client.removeChannel(supabaseChannel);
  supabaseChannel = null;
}

function supabaseRowToMessage(row) {
  if (!row) return null;
  const createdAtMs = row.created_at ? Date.parse(row.created_at) : nowMs();
  const createdAtSec = Math.floor(createdAtMs / 1000);
  return {
    id: row.id || "",
    room: normalizeRoom(row.room || ""),
    nick: row.nick || "Anonymous",
    text: row.text || "",
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    reply: row.reply && typeof row.reply === "object" ? row.reply : null,
    action: !!row.action,
    createdAtSec,
    ts: createdAtMs,
    receivedAtMs: nowMs()
  };
}

const audioManager = (() => {
  const sources = new Map();
  let currentSourceId = null;
  let currentType = null;
  let isPlaying = false;
  const recentIds = [];

  function bumpRecent(id) {
    const idx = recentIds.indexOf(id);
    if (idx >= 0) recentIds.splice(idx, 1);
    recentIds.unshift(id);
  }

  function registerSource(src) {
    if (!src || !src.id) return;
    sources.set(src.id, src);
    bumpRecent(src.id);
    updateNowPlaying();
  }

  function unregisterSource(id) {
    if (!id) return;
    sources.delete(id);
    const idx = recentIds.indexOf(id);
    if (idx >= 0) recentIds.splice(idx, 1);
    if (currentSourceId === id) {
      currentSourceId = null;
      currentType = null;
      isPlaying = false;
    }
    updateNowPlaying();
  }

  function pauseAllExcept(id) {
    for (const [sid, src] of sources.entries()) {
      if (sid === id) continue;
      try {
        src.pause?.();
      } catch {
        // ignore
      }
    }
  }

  function requestFocus(id) {
    if (!sources.has(id)) return;
    pauseAllExcept(id);
    currentSourceId = id;
    currentType = sources.get(id)?.type || null;
    isPlaying = true;
    bumpRecent(id);
    updateNowPlaying();
  }

  function markPaused(id) {
    if (currentSourceId !== id) return;
    isPlaying = false;
    updateNowPlaying();
  }

  function playCurrent() {
    const src = currentSourceId ? sources.get(currentSourceId) : null;
    if (!src) return;
    try {
      src.play?.();
      isPlaying = true;
      updateNowPlaying();
    } catch {
      // ignore
    }
  }

  function pauseCurrent() {
    const src = currentSourceId ? sources.get(currentSourceId) : null;
    if (!src) return;
    try {
      src.pause?.();
      isPlaying = false;
      updateNowPlaying();
    } catch {
      // ignore
    }
  }

  function stopCurrent() {
    const src = currentSourceId ? sources.get(currentSourceId) : null;
    if (!src) return;
    try {
      src.stop?.();
    } catch {
      // ignore
    }
    isPlaying = false;
    currentSourceId = null;
    currentType = null;
    updateNowPlaying();
  }

  function switchSource() {
    if (sources.size < 2) return;
    const options = recentIds.filter((id) => sources.has(id));
    const currentIdx = options.indexOf(currentSourceId);
    const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % options.length : 0;
    const nextId = options[nextIdx];
    if (!nextId) return;
    requestFocus(nextId);
    const src = sources.get(nextId);
    src?.play?.();
  }

  function clearAll() {
    for (const src of sources.values()) {
      try {
        src.stop?.();
      } catch {
        // ignore
      }
    }
    sources.clear();
    recentIds.length = 0;
    currentSourceId = null;
    currentType = null;
    isPlaying = false;
    updateNowPlaying();
  }

  function getCurrent() {
    if (!currentSourceId) return null;
    return sources.get(currentSourceId) || null;
  }

  return {
    registerSource,
    unregisterSource,
    requestFocus,
    markPaused,
    playCurrent,
    pauseCurrent,
    stopCurrent,
    switchSource,
    clearAll,
    getCurrent,
    isPlaying: () => isPlaying,
    currentType: () => currentType
  };
})();

const eventListeners = new Map();
const listen = async (name, handler) => {
  if (!eventListeners.has(name)) eventListeners.set(name, new Set());
  eventListeners.get(name).add(handler);
  return () => eventListeners.get(name)?.delete(handler);
};
function emitEvent(name, payload) {
  const handlers = eventListeners.get(name);
  if (!handlers) return;
  handlers.forEach((handler) => handler({ payload }));
}

const invoke = async (cmd, payload = {}) => {
  switch (cmd) {
    case "get_state":
      return getStateSnapshot();
    case "save_settings":
      return saveSettingsInternal(payload.settings);
    case "add_room":
      return addRoomInternal(payload.room);
    case "remove_room":
      return removeRoomInternal(payload.room);
    case "get_room_messages":
      return getRoomMessagesInternal(payload.room);
    case "send_message":
      return sendMessageInternal(payload.message);
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
};

const roomListEl = el("room-list");
const commandInput = el("command-input");
const messageInput = el("message-input");
const messagesEl = el("messages");
const inlinePreviews = el("inline-previews");
const relayStatusEl = el("relay-status");
const currentRoomEl = el("current-room");
const connectBtn = el("connect-btn");
const sendBtn = el("send-btn");
const attachBtn = el("attach-btn");
const settingsBtn = el("settings-btn");
const settingsModal = el("settings-modal");
const settingsClose = el("settings-close");
const settingsSave = el("settings-save");
const confirmModal = el("confirm-modal");
const confirmTitle = el("confirm-title");
const confirmBody = el("confirm-body");
const confirmOk = el("confirm-ok");
const confirmCancel = el("confirm-cancel");
const nickInput = el("nick-input");
const maxImageInput = el("max-image-kb");
const maxPayloadInput = el("max-payload-kb");
const supabaseUploadToggle = el("supabase-upload-toggle");
const supabaseUrlInput = el("supabase-url");
const supabaseAnonKeyInput = el("supabase-anon-key");
const supabaseBucketInput = el("supabase-bucket");
const fileInput = el("file-input");
const toastStack = el("toast-stack");
const statusBanner = el("status-banner");
const imageViewer = el("image-viewer");
const viewerImage = el("viewer-image");
const jumpLatest = el("jump-latest");
const sidebarToggle = el("sidebar-toggle");
const sidebarOverlay = el("sidebar-overlay");
const replyBar = el("reply-bar");
const replyNick = el("reply-nick");
const replySnippet = el("reply-snippet");
const replyCancel = el("reply-cancel");
const nowPlaying = el("now-playing");
const npTitle = el("np-title");
const npMeta = el("np-meta");
const npPlay = el("np-play");
const npStop = el("np-stop");
const npSwitch = el("np-switch");
const toolbar = document.querySelector(".toolbar");

const MESSAGE_MIN_HEIGHT = 44;
const MESSAGE_MAX_HEIGHT = 220;
const MESSAGE_FLOW_REVERSE = false;

let confirmResolver = null;
let lastMessagesScrollTop = 0;

function showToast(text, variant = "info", timeoutMs = 6000) {
  if (!text) return;
  const toast = document.createElement("div");
  toast.className = `toast ${variant === "error" ? "error" : ""}`.trim();
  toast.textContent = text;
  toastStack.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, timeoutMs);
}


function normalizeRoom(room) {
  const trimmed = String(room || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function normalizeRooms(list) {
  const out = [];
  const seen = new Set();
  for (const room of list || []) {
    const normalized = normalizeRoom(room);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function defaultSettings() {
  return {
    nick: "Anonymous",
    rooms: ["#echo"],
    max_image_kb: 200,
    max_payload_kb: 6000,
    supabase_upload: false,
    supabase_url: DEFAULT_SUPABASE_URL,
    supabase_anon_key: DEFAULT_SUPABASE_ANON_KEY,
    supabase_bucket: "echochan-images"
  };
}

function loadSettingsFromStorage() {
  const raw = localStorage.getItem("echochan_settings");
  let settings = defaultSettings();
  if (raw) {
    try {
      settings = { ...settings, ...JSON.parse(raw) };
    } catch {
      settings = defaultSettings();
    }
  }
  settings.rooms = normalizeRooms(settings.rooms || []);
  if (!settings.max_payload_kb || settings.max_payload_kb < 6000) {
    settings.max_payload_kb = 6000;
  }
  if (!settings.rooms.length) settings.rooms = ["#echo"];
  return settings;
}

function saveSettingsToStorage(settings) {
  localStorage.setItem("echochan_settings", JSON.stringify(settings));
}

function getCreatedAtSec(msg) {
  if (msg && typeof msg.createdAtSec === "number") return msg.createdAtSec;
  const ts = Number(msg?.ts || msg?.receivedAtMs || 0);
  return ts ? Math.floor(ts / 1000) : 0;
}

function computeMessageId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getSortKeySec(msg) {
  const created = getCreatedAtSec(msg);
  const nowSec = Math.floor(nowMs() / 1000);
  if (!created) return nowSec;
  const diff = Math.abs(created - nowSec);
  // Guard against bad sender clocks: keep very skewed messages near arrival.
  if (diff > 6 * 3600) {
    const recv = Math.floor((msg?.receivedAtMs || nowMs()) / 1000);
    return recv || created;
  }
  return created;
}

function compareMessages(a, b) {
  const ta = getSortKeySec(a);
  const tb = getSortKeySec(b);
  if (ta !== tb) return ta - tb;
  const aid = String(a?.id || "");
  const bid = String(b?.id || "");
  return aid.localeCompare(bid);
}

function dayKeyFromSec(sec) {
  if (!sec) return "unknown";
  const date = new Date(sec * 1000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayLabelFromSec(sec) {
  if (!sec) return "";
  const date = new Date(sec * 1000);
  const today = new Date();
  const yKey = dayKeyFromSec(Math.floor((today.getTime() - 86400000) / 1000));
  const tKey = dayKeyFromSec(Math.floor(today.getTime() / 1000));
  const key = dayKeyFromSec(sec);
  if (key === tKey) return "Сегодня";
  if (key === yKey) return "Вчера";
  return key;
}

function createDaySeparator(sec) {
  const sep = document.createElement("div");
  sep.className = "day-separator";
  sep.dataset.dayKey = dayKeyFromSec(sec);
  sep.textContent = dayLabelFromSec(sec);
  return sep;
}

function colorForNick(nick) {
  const name = String(nick || "Anonymous");
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 55%, 70%)`;
}

function buildReplyPreview(msg) {
  if (!msg) return null;
  const cleaned = stripEmbedLinks(String(msg.text || ""));
  const text = cleaned.trim();
  if (text) {
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }
  if (msg.attachments && msg.attachments.length) return "[media]";
  return "(no text)";
}

function setReplyTarget(msg) {
  if (!msg || !msg.id) return;
  state.replyTo = {
    id: msg.id,
    nick: msg.nick || "Anonymous",
    text: buildReplyPreview(msg),
    ts: msg.ts || nowMs()
  };
  updateReplyBar();
}

function clearReplyTarget() {
  state.replyTo = null;
  updateReplyBar();
}

function updateReplyBar() {
  if (!replyBar) return;
  if (!state.replyTo) {
    replyBar.classList.add("hidden");
    if (replyNick) replyNick.textContent = "";
    if (replySnippet) replySnippet.textContent = "";
    return;
  }
  replyBar.classList.remove("hidden");
  if (replyNick) replyNick.textContent = state.replyTo.nick;
  if (replySnippet) replySnippet.textContent = state.replyTo.text || "";
}

function scrollToMessageId(id) {
  if (!id) return;
  const target = messagesEl.querySelector(`[data-msg-id="${id}"]`);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 800);
}

let replyPreviewEl = null;
function showReplyPreview(anchor, replyId) {
  if (!anchor) return;
  if (!replyPreviewEl) {
    replyPreviewEl = document.createElement("div");
    replyPreviewEl.className = "reply-tooltip";
    document.body.appendChild(replyPreviewEl);
  }
  const original = messageIndex.get(replyId);
  if (!original) {
    replyPreviewEl.textContent = "Original message not available";
  } else {
    const head = `${original.nick || "Anonymous"} · ${formatTime(
      original.createdAtSec || getCreatedAtSec(original)
    )}`;
    const text = original.text || "";
    replyPreviewEl.textContent = `${head}\n${text}`;
  }
  const rect = anchor.getBoundingClientRect();
  replyPreviewEl.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
  replyPreviewEl.style.top = `${Math.max(12, rect.top - 8)}px`;
  replyPreviewEl.classList.add("visible");
}

function hideReplyPreview() {
  if (!replyPreviewEl) return;
  replyPreviewEl.classList.remove("visible");
}

function isMessagesAtBottom() {
  const threshold = 80;
  const distance =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  return distance <= threshold;
}

function updateJumpButton() {
  if (!jumpLatest) return;
  if (state.isAtBottom) {
    jumpLatest.classList.add("hidden");
  } else {
    jumpLatest.classList.remove("hidden");
  }
}

function findPrevMessageEl(el) {
  let node = el.previousSibling;
  while (node) {
    if (node.classList?.contains("message")) return node;
    node = node.previousSibling;
  }
  return null;
}

function findNextMessageEl(el) {
  let node = el.nextSibling;
  while (node) {
    if (node.classList?.contains("message")) return node;
    node = node.nextSibling;
  }
  return null;
}

function ensureDaySeparatorsAround(wrapper, msg) {
  const currDay = wrapper.dataset.dayKey || dayKeyFromSec(getCreatedAtSec(msg));
  const prevMsg = findPrevMessageEl(wrapper);
  const nextMsg = findNextMessageEl(wrapper);

  const prevDay = prevMsg ? prevMsg.dataset.dayKey : null;
  const prevSep = wrapper.previousSibling?.classList?.contains("day-separator")
    ? wrapper.previousSibling
    : null;
  if (prevDay !== currDay) {
    if (!prevSep || prevSep.nextSibling !== wrapper) {
      const sep = createDaySeparator(getCreatedAtSec(msg));
      messagesEl.insertBefore(sep, wrapper);
    }
  } else if (prevSep) {
    prevSep.remove();
  }

  const nextDay = nextMsg ? nextMsg.dataset.dayKey : null;
  const nextSep = wrapper.nextSibling?.classList?.contains("day-separator")
    ? wrapper.nextSibling
    : null;
  if (nextMsg && nextDay !== currDay) {
    if (!nextSep || nextSep.previousSibling !== wrapper) {
      const sep = createDaySeparator(getCreatedAtSec(nextMsg));
      messagesEl.insertBefore(sep, nextMsg);
    }
  } else if (nextSep && nextDay === currDay) {
    nextSep.remove();
  }
}

function setMetaVisibility(wrapper, show) {
  const meta = wrapper.querySelector(".meta");
  if (!meta) return;
  meta.classList.toggle("compact", !show);
}

function recomputeGrouping(wrapper) {
  if (!wrapper) return;
  if (wrapper.dataset.groupable !== "1") {
    setMetaVisibility(wrapper, true);
    return;
  }
  const prev = findPrevMessageEl(wrapper);
  if (!prev || prev.dataset.groupable !== "1") {
    setMetaVisibility(wrapper, true);
    return;
  }
  const sameAuthor = prev.dataset.author === wrapper.dataset.author;
  const sameDay = prev.dataset.dayKey === wrapper.dataset.dayKey;
  setMetaVisibility(wrapper, !(sameAuthor && sameDay));
}

function updateNowPlaying() {
  if (!nowPlaying) return;
  const current = audioManager.getCurrent();
  if (!current) {
    nowPlaying.classList.add("empty");
    if (npTitle) npTitle.textContent = "No audio";
    if (npMeta) npMeta.textContent = "";
    return;
  }
  nowPlaying.classList.remove("empty");
  if (npTitle) npTitle.textContent = current.title || "Now playing";
  if (npMeta) npMeta.textContent = current.type ? current.type.toUpperCase() : "";
  if (npPlay) npPlay.textContent = audioManager.isPlaying() ? "⏸" : "▶";
}

let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    if (!document.getElementById("yt-iframe-api")) {
      const script = document.createElement("script");
      script.id = "yt-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });
  return ytApiPromise;
}

function registerYouTubePlayer(iframe, title) {
  if (!iframe || !iframe.id) return;
  const sourceId = iframe.id;
  loadYouTubeApi().then((YT) => {
    const player = new YT.Player(sourceId, {
      events: {
        onStateChange: (event) => {
          if (event.data === YT.PlayerState.PLAYING) {
            audioManager.requestFocus(sourceId);
          } else if (
            event.data === YT.PlayerState.PAUSED ||
            event.data === YT.PlayerState.ENDED
          ) {
            audioManager.markPaused(sourceId);
          }
        }
      }
    });
    audioManager.registerSource({
      id: sourceId,
      type: "youtube",
      title: title || "YouTube",
      play: () => player.playVideo(),
      pause: () => player.pauseVideo(),
      stop: () => player.stopVideo()
    });
  });
}

function registerHtmlAudio(audio, title) {
  if (!audio) return;
  const sourceId = audio.id || `audio-${randomId()}`;
  audio.id = sourceId;
  audioManager.registerSource({
    id: sourceId,
    type: "html5",
    title: title || audio.getAttribute("data-title") || "Audio",
    play: () => audio.play(),
    pause: () => audio.pause(),
    stop: () => {
      audio.pause();
      audio.currentTime = 0;
    }
  });
  audio.addEventListener("play", () => audioManager.requestFocus(sourceId));
  audio.addEventListener("pause", () => audioManager.markPaused(sourceId));
  audio.addEventListener("ended", () => audioManager.markPaused(sourceId));
}

function registerExternalEmbed(iframe, { type, title } = {}) {
  if (!iframe) return;
  const sourceId = iframe.id || `${type || "embed"}-${randomId()}`;
  iframe.id = sourceId;
  if (!iframe.dataset.src) iframe.dataset.src = iframe.src;
  if (!iframe.dataset.autoplay) {
    const src = iframe.dataset.src;
    let autoplay = src;
    if (type === "spotify") {
      autoplay = src.includes("?") ? `${src}&autoplay=1` : `${src}?autoplay=1`;
    } else if (type === "yandex") {
      autoplay = src.includes("?") ? `${src}&autoplay=1` : `${src}?autoplay=1`;
    }
    iframe.dataset.autoplay = autoplay;
  }
  const wrapper = iframe.parentElement;
  const overlay = wrapper ? wrapper.querySelector(".embed-overlay") : null;
  if (overlay) overlay.remove();
  audioManager.registerSource({
    id: sourceId,
    type: type || "other",
    title: title || "Embed",
    play: () => {
      iframe.src = iframe.dataset.autoplay || iframe.dataset.src;
    },
    pause: () => {
      iframe.src = iframe.dataset.src;
    },
    stop: () => {
      iframe.src = iframe.dataset.src;
    }
  });
}

function resubscribeRelays() {
  subscribeSupabaseRoom(state.currentRoom);
}

function showStatusBanner(text, timeoutMs = 2500) {
  if (!statusBanner) return;
  statusBanner.textContent = text;
  statusBanner.classList.remove("hidden");
  if (showStatusBanner._timer) {
    clearTimeout(showStatusBanner._timer);
  }
  showStatusBanner._timer = setTimeout(() => {
    statusBanner.classList.add("hidden");
  }, timeoutMs);
}

function subscribeSupabaseRoom(room) {
  const client = getSupabaseClient();
  if (!client) return;
  const normalized = normalizeRoom(room);
  if (!normalized) return;
  resetSupabaseChannel();
  supabaseChannel = client
    .channel(`messages:${normalized}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `room=eq.${normalized}`
      },
      (payload) => {
        const msg = supabaseRowToMessage(payload.new);
        if (!msg) return;
        if (insertMessage(msg)) {
          emitEvent("new-message", msg);
        }
      }
    )
    .subscribe();
}

function updateLastCreatedAt(room, msg) {
  if (!msg || !room) return;
  const ms = msg.createdAtSec
    ? msg.createdAtSec * 1000
    : msg.ts || nowMs();
  const prev = state.lastCreatedAtByRoom?.get(room) || 0;
  if (ms > prev) state.lastCreatedAtByRoom.set(room, ms);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollRoom = null;
}

function startPolling(room) {
  if (!useSupabase()) return;
  if (pollRoom === room && pollTimer) return;
  stopPolling();
  pollRoom = room;
  pollNewMessages(room);
  pollTimer = setInterval(() => pollNewMessages(room), 5000);
}

async function pollNewMessages(room) {
  const client = getSupabaseClient();
  if (!client) return;
  const normalized = normalizeRoom(room);
  if (!normalized) return;
  const lastMs = state.lastCreatedAtByRoom?.get(normalized) || 0;
  const sinceIso = lastMs ? new Date(lastMs).toISOString() : null;
  let query = client.from("messages").select("*").eq("room", normalized);
  if (sinceIso) query = query.gt("created_at", sinceIso);
  const { data, error } = await query.order("created_at", { ascending: true }).limit(100);
  if (error) return;
  const rows = (data || []).map((row) => supabaseRowToMessage(row)).filter(Boolean);
  let insertedAny = false;
  rows.forEach((msg) => {
    if (insertMessage(msg)) {
      insertedAny = true;
      updateLastCreatedAt(normalized, msg);
      emitEvent("new-message", msg);
    }
  });
  if (!insertedAny && lastMs === 0 && rows.length) {
    const last = rows[rows.length - 1];
    updateLastCreatedAt(normalized, last);
  }
}

function insertMessage(msg) {
  if (!msg) return false;
  if (!msg.id) msg.id = computeMessageId(msg);
  if (!msg.createdAtSec) msg.createdAtSec = getCreatedAtSec(msg);
  if (!msg.receivedAtMs) msg.receivedAtMs = nowMs();
  if (seenIds.has(msg.id)) return false;
  seenIds.add(msg.id);
  messageIndex.set(msg.id, msg);
  const list = messagesByRoom.get(msg.room) || [];
  list.push(msg);
  list.sort(compareMessages);
  if (list.length > 500) {
    const removed = list.shift();
    if (removed?.id) messageIndex.delete(removed.id);
  }
  messagesByRoom.set(msg.room, list);
  if (!state.lastCreatedAtByRoom) state.lastCreatedAtByRoom = new Map();
  updateLastCreatedAt(msg.room, msg);
  return true;
}

async function getStateSnapshot() {
  const counts = {};
  messagesByRoom.forEach((list, room) => {
    counts[room] = list.length;
  });
  return {
    settings: state.settings,
    counts
  };
}

async function saveSettingsInternal(settings) {
  const next = { ...state.settings, ...settings };
  next.rooms = normalizeRooms(next.rooms || []);
  if (!next.rooms.length) next.rooms = ["#echo"];
  state.settings = next;
  saveSettingsToStorage(next);
  resubscribeRelays();
}

async function addRoomInternal(room) {
  const normalized = normalizeRoom(room);
  if (!normalized) return;
  if (!state.settings.rooms.includes(normalized)) {
    state.settings.rooms.push(normalized);
    saveSettingsToStorage(state.settings);
    resubscribeRelays();
  }
}

async function removeRoomInternal(room) {
  const normalized = normalizeRoom(room);
  if (!normalized) return;
  if (state.settings.rooms.length <= 1) {
    throw new Error("At least one room must remain.");
  }
  state.settings.rooms = state.settings.rooms.filter((r) => r !== normalized);
  saveSettingsToStorage(state.settings);
  resubscribeRelays();
}

async function getRoomMessagesInternal(room) {
  const normalized = normalizeRoom(room);
  if (!useSupabase()) {
    return messagesByRoom.get(normalized) || [];
  }
  const client = getSupabaseClient();
  const { data, error } = await client
    .from("messages")
    .select("*")
    .eq("room", normalized)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data || [])
    .map((row) => supabaseRowToMessage(row))
    .filter(Boolean);
}

async function sendMessageInternal(message) {
  if (!useSupabase()) {
    throw new Error("Supabase is not configured.");
  }
  if (message.attachments?.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Only ${MAX_ATTACHMENT_COUNT} attachments allowed.`);
  }
  const room = normalizeRoom(message.room);
  const client = getSupabaseClient();
  const row = {
    room,
    nick: message.nick || "Anonymous",
    text: message.text || "",
    attachments: message.attachments || [],
    reply: message.reply || null,
    action: !!message.action
  };
  const { data, error } = await client.from("messages").insert(row).select().single();
  if (error) throw new Error(error.message);
  return supabaseRowToMessage(data);
}

function nowMs() {
  return Date.now();
}

function setStatus(text) {
  relayStatusEl.textContent = text;
}

function openConfirm({ title, body, okText }) {
  return new Promise((resolve) => {
    confirmResolver = resolve;
    confirmTitle.textContent = title || "Confirm";
    confirmBody.textContent = body || "Are you sure?";
    confirmOk.textContent = okText || "OK";
    confirmModal.classList.remove("hidden");
  });
}

function closeConfirm(result) {
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
  confirmModal.classList.add("hidden");
}

function autoResizeTextarea() {
  messageInput.style.height = "auto";
  const next = Math.max(messageInput.scrollHeight, MESSAGE_MIN_HEIGHT);
  messageInput.style.height = `${next}px`;
}

function formatTime(createdAtSec) {
  const ts = Number(createdAtSec || 0) * 1000;
  if (!ts) return "";
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  if (sameDay) {
    return `${hh}:${mm}`;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function extractYouTubeId(text) {
  if (!text) return "";
  const patterns = [
    /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{6,})/i,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{6,})/i,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i,
    /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/i
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match && match[1]) return match[1];
  }
  return "";
}

function extractSpotifyEmbed(text) {
  if (!text) return null;
  const re =
    /(?:https?:\/\/)?open\.spotify\.com\/(track|album|playlist|episode|show)\/([A-Za-z0-9]+)(?:\?[^ \n]*)?/i;
  const match = text.match(re);
  if (!match) return null;
  return { type: match[1], id: match[2] };
}

function extractYandexMusicEmbed(text) {
  if (!text) return "";
  const iframe = text.match(/https?:\/\/music\.yandex\.ru\/iframe\/#([A-Za-z0-9/_-]+)/i);
  if (iframe && iframe[1]) {
    return `https://music.yandex.ru/iframe/#${iframe[1]}`;
  }
  const albumTrack = text.match(/https?:\/\/music\.yandex\.ru\/album\/(\d+)\/track\/(\d+)/i);
  if (albumTrack) {
    const albumId = albumTrack[1];
    const trackId = albumTrack[2];
    return `https://music.yandex.ru/iframe/#track/${trackId}/${albumId}`;
  }
  const track = text.match(/https?:\/\/music\.yandex\.ru\/track\/(\d+)/i);
  if (track) {
    const trackId = track[1];
    return `https://music.yandex.ru/iframe/#track/${trackId}`;
  }
  return "";
}

function stripEmbedLinks(text) {
  if (!text) return "";
  let out = text;
  const patterns = [
    /https?:\/\/(?:www\.)?youtu\.be\/[A-Za-z0-9_-]+(?:\?[^ \n]*)?/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[A-Za-z0-9_-]+(?:\&[^ \n]*)?/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[A-Za-z0-9_-]+(?:\?[^ \n]*)?/gi,
    /https?:\/\/(?:www\.)?youtube\.com\/embed\/[A-Za-z0-9_-]+(?:\?[^ \n]*)?/gi,
    /https?:\/\/open\.spotify\.com\/(track|album|playlist|episode|show)\/[A-Za-z0-9]+(?:\?[^ \n]*)?/gi,
    /https?:\/\/music\.yandex\.ru\/iframe\/#[A-Za-z0-9/_-]+/gi,
    /https?:\/\/music\.yandex\.ru\/album\/\d+\/track\/\d+/gi,
    /https?:\/\/music\.yandex\.ru\/track\/\d+/gi
  ];
  for (const re of patterns) {
    out = out.replace(re, "");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function renderRooms() {
  roomListEl.innerHTML = "";
  state.rooms.forEach((room) => {
    const row = document.createElement("div");
    row.className = "room" + (room === state.currentRoom ? " active" : "");
    const name = document.createElement("span");
    name.textContent = room;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = state.roomCounts[room] || 0;
    const remove = document.createElement("button");
    remove.className = "room-remove";
    remove.textContent = "×";
    remove.title = "Remove room";
    remove.addEventListener("click", async (evt) => {
      evt.stopPropagation();
      if (state.rooms.length <= 1) {
        setStatus("At least one room must remain.");
        return;
      }
      const confirmed = await openConfirm({
        title: "Remove room",
        body: `Remove room ${room}?`,
        okText: "Remove"
      });
      if (!confirmed) return;
      await invoke("remove_room", { room });
      state.rooms = state.rooms.filter((r) => r !== room);
      if (state.currentRoom === room) {
        state.currentRoom = state.rooms[0];
        currentRoomEl.textContent = state.currentRoom;
        await loadRoomMessages(state.currentRoom);
      }
      renderRooms();
      addSystemMessage(`Left ${room}.`);
    });
    row.append(name, count, remove);
    row.addEventListener("click", async () => {
      document.body.classList.remove("sidebar-open");
      state.currentRoom = room;
      currentRoomEl.textContent = room;
      renderRooms();
      await loadRoomMessages(room);
    });
    roomListEl.appendChild(row);
  });
}

function renderMessages(list, { autoScroll = true } = {}) {
  audioManager.clearAll();
  messagesEl.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No messages yet. Try /join #room or type a message.";
    messagesEl.appendChild(empty);
  }
  const ordered = [...list].sort((a, b) => {
    const cmp = compareMessages(a, b);
    return MESSAGE_FLOW_REVERSE ? -cmp : cmp;
  });
  let prevAuthor = null;
  let prevDay = null;
  let prevGroupable = false;
  ordered.forEach((msg) => {
    msg.createdAtSec = msg.createdAtSec || getCreatedAtSec(msg);
    msg.receivedAtMs = msg.receivedAtMs || nowMs();
    const dayKey = dayKeyFromSec(msg.createdAtSec);
    if (dayKey !== prevDay) {
      messagesEl.appendChild(createDaySeparator(msg.createdAtSec));
      prevDay = dayKey;
      prevAuthor = null;
      prevGroupable = false;
    }
    const groupable = !msg.system;
    const showMeta = !(groupable && prevGroupable && prevAuthor === msg.nick);
    const wrapper = addMessageToDom(msg, { showMeta });
    if (msg?.id) {
      seenIds.add(msg.id);
      messageIndex.set(msg.id, msg);
    }
    if (groupable) {
      prevAuthor = msg.nick;
      prevGroupable = true;
    } else {
      prevAuthor = null;
      prevGroupable = false;
    }
    if (wrapper) {
      // grouping handled by addMessageToDom
    }
  });
  if (autoScroll) {
    scrollMessagesToLatest(true);
  } else {
    state.isAtBottom = isMessagesAtBottom();
    updateJumpButton();
  }
  if (ordered.length) {
    const last = MESSAGE_FLOW_REVERSE ? ordered[0] : ordered[ordered.length - 1];
    if (last && last.id) {
      state.lastMessageId.set(state.currentRoom, last.id);
    }
  }
}

function scrollMessagesToLatest(force = false) {
  if (!force && !state.isAtBottom) {
    updateJumpButton();
    return;
  }
  requestAnimationFrame(() => {
    messagesEl.scrollTop = MESSAGE_FLOW_REVERSE ? 0 : messagesEl.scrollHeight;
    state.isAtBottom = true;
    updateJumpButton();
  });
}

function addSystemMessage(text) {
  const msg = {
    nick: "system",
    createdAtSec: Math.floor(nowMs() / 1000),
    ts: nowMs(),
    text,
    action: false,
    attachments: [],
    system: true
  };
  addMessageToDom(msg);
  scrollMessagesToLatest();
}

function addMessageToDom(msg, { sorted = false, showMeta = true } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = msg.system ? "message system" : "message";
  if (msg && msg.id) {
    wrapper.dataset.msgId = msg.id;
  }
  const createdAtSec = msg?.createdAtSec || getCreatedAtSec(msg) || 0;
  wrapper.dataset.createdAtSec = String(createdAtSec);
  wrapper.dataset.dayKey = dayKeyFromSec(createdAtSec);
  wrapper.dataset.author = msg.nick || "Anonymous";
  wrapper.dataset.groupable = msg.system ? "0" : "1";
  const empty = messagesEl.querySelector(".empty-state");
  if (empty) empty.remove();
  const body = document.createElement("div");
  const youtubeId = extractYouTubeId(msg.text);
  const spotify = extractSpotifyEmbed(msg.text);
  const yandexSrc = extractYandexMusicEmbed(msg.text);
  const hasMedia =
    (msg.attachments && msg.attachments.length) || youtubeId || spotify || yandexSrc;
  const textRaw = msg.action ? `* ${msg.nick} ${msg.text}` : stripEmbedLinks(msg.text);
  const hasText = Boolean(textRaw);
  const mediaOnly = hasMedia && !hasText;
  body.className = "message-body";
  if (hasMedia) body.classList.add("has-media");
  if (mediaOnly) body.classList.add("media-only");
  const meta = document.createElement("div");
  meta.className = "meta";
  const metaLeft = document.createElement("div");
  metaLeft.className = "meta-left";
  const nickSpan = document.createElement("span");
  nickSpan.className = "nick";
  nickSpan.textContent = msg.nick || "Anonymous";
  nickSpan.style.color = colorForNick(nickSpan.textContent);
  const timeSpan = document.createElement("span");
  timeSpan.className = "time";
  timeSpan.textContent = formatTime(msg.createdAtSec || getCreatedAtSec(msg));
  metaLeft.append(nickSpan, timeSpan);
  meta.appendChild(metaLeft);
  if (!msg.system) {
    const replyBtn = document.createElement("button");
    replyBtn.className = "reply-btn";
    replyBtn.textContent = "Reply";
    replyBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      setReplyTarget(msg);
    });
    meta.appendChild(replyBtn);
  }
  const text = document.createElement("div");
  text.className = "text";
  const cleanedText = textRaw;
  text.textContent = cleanedText;
  const content = document.createElement("div");
  content.className = "message-content";
  if (msg.reply && msg.reply.id) {
    const replyLine = document.createElement("div");
    replyLine.className = "reply-snippet-inline";
    const replyNickText = msg.reply.nick || "Anonymous";
    const replyText = msg.reply.text || "";
    replyLine.textContent = `${replyNickText}: ${replyText}`;
    replyLine.addEventListener("mouseenter", () => showReplyPreview(replyLine, msg.reply.id));
    replyLine.addEventListener("mouseleave", hideReplyPreview);
    replyLine.addEventListener("click", () => scrollToMessageId(msg.reply.id));
    content.appendChild(replyLine);
  }
  if (cleanedText) {
    content.appendChild(text);
  }
  body.appendChild(content);
  wrapper.appendChild(meta);
  const mediaColumn = document.createElement("div");
  mediaColumn.className = "attachments";
  const youtubeEmbed = youtubeId
    ? (() => {
        const embed = document.createElement("div");
        embed.className = "youtube-embed";
        const iframe = document.createElement("iframe");
        const origin = encodeURIComponent(window.location.origin);
        iframe.src = `https://www.youtube-nocookie.com/embed/${youtubeId}?enablejsapi=1&origin=${origin}&playsinline=1`;
        iframe.title = "YouTube video";
        iframe.allow =
          "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
        iframe.referrerPolicy = "origin-when-cross-origin";
        iframe.allowFullscreen = true;
        iframe.id = `yt-${msg.id || randomId()}`;
        embed.appendChild(iframe);
        return embed;
      })()
    : null;
  const spotifyEmbed = spotify
    ? (() => {
        const embed = document.createElement("div");
        embed.className = "spotify-embed";
        const iframe = document.createElement("iframe");
        iframe.src = `https://open.spotify.com/embed/${spotify.type}/${spotify.id}`;
        iframe.title = "Spotify";
        iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
        iframe.loading = "lazy";
        iframe.referrerPolicy = "origin-when-cross-origin";
        iframe.id = `sp-${msg.id || randomId()}`;
        embed.appendChild(iframe);
        return embed;
      })()
    : null;
  const yandexEmbed = yandexSrc
    ? (() => {
        const embed = document.createElement("div");
        embed.className = "yandex-embed";
        const iframe = document.createElement("iframe");
        iframe.src = yandexSrc;
        iframe.title = "Yandex Music";
        iframe.allow = "autoplay; clipboard-write; encrypted-media";
        iframe.loading = "lazy";
        iframe.referrerPolicy = "origin-when-cross-origin";
        iframe.id = `ym-${msg.id || randomId()}`;
        embed.appendChild(iframe);
        return embed;
      })()
    : null;
  if (msg.attachments && msg.attachments.length) {
    msg.attachments.forEach((att) => {
      const mime = inferAttachmentMime(att);
      if (mime.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = att.data;
        img.alt = "attachment";
        img.addEventListener("click", () => openImageViewer(att.data));
        mediaColumn.appendChild(img);
      }
    });
  }
  if (youtubeEmbed) mediaColumn.appendChild(youtubeEmbed);
  if (spotifyEmbed) mediaColumn.appendChild(spotifyEmbed);
  if (yandexEmbed) mediaColumn.appendChild(yandexEmbed);
  if (hasMedia) {
    body.insertBefore(mediaColumn, content);
  }
  wrapper.appendChild(body);
  if (!showMeta) {
    setMetaVisibility(wrapper, false);
  }
  if (sorted) {
    const nodes = Array.from(messagesEl.querySelectorAll(".message"));
    let inserted = false;
    for (const node of nodes) {
      const nodeMsg = {
        createdAtSec: Number(node.dataset.createdAtSec || 0),
        id: node.dataset.msgId || ""
      };
      if (compareMessages(msg, nodeMsg) < 0) {
        messagesEl.insertBefore(wrapper, node);
        inserted = true;
        break;
      }
    }
    if (!inserted) messagesEl.appendChild(wrapper);
    ensureDaySeparatorsAround(wrapper, msg);
    recomputeGrouping(wrapper);
    recomputeGrouping(findNextMessageEl(wrapper));
  } else {
    messagesEl.appendChild(wrapper);
  }
  if (youtubeEmbed) {
    const iframe = youtubeEmbed.querySelector("iframe");
    if (iframe) {
      registerYouTubePlayer(iframe, stripEmbedLinks(msg.text) || "YouTube");
    }
  }
  if (spotifyEmbed) {
    const iframe = spotifyEmbed.querySelector("iframe");
    if (iframe) registerExternalEmbed(iframe, { type: "spotify", title: "Spotify" });
  }
  if (yandexEmbed) {
    const iframe = yandexEmbed.querySelector("iframe");
    if (iframe) registerExternalEmbed(iframe, { type: "yandex", title: "Yandex Music" });
  }
  wrapper.querySelectorAll("audio").forEach((audio) => registerHtmlAudio(audio));
  if (msg && msg.id) {
    state.lastMessageId.set(msg.room || state.currentRoom, msg.id);
  }
  return wrapper;
}

function openImageViewer(src) {
  if (!src) return;
  viewerImage.src = src;
  imageViewer.classList.remove("hidden");
}

function closeImageViewer() {
  imageViewer.classList.add("hidden");
  viewerImage.src = "";
}

function updateInlinePreviews() {
  inlinePreviews.innerHTML = "";
  state.attachments.forEach((att) => {
    const mime = inferAttachmentMime(att);
    if (mime.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = att.data;
      inlinePreviews.appendChild(img);
      return;
    }
    // ignore non-image attachments
  });
}

function estimatePayloadKB(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json).length;
  return bytes / 1024;
}

async function loadState() {
  state.settings = loadSettingsFromStorage();
  const snapshot = await invoke("get_state", {});
  state.settings = snapshot.settings;
  const normalizedRooms = normalizeRooms(snapshot.settings.rooms);
  state.rooms = normalizedRooms;
  state.roomCounts = snapshot.counts || {};
  state.currentRoom = state.rooms[0] || "#test";
  state.maxImageKB = snapshot.settings.max_image_kb;
  state.maxPayloadKB = snapshot.settings.max_payload_kb;

  if (nickInput) nickInput.value = snapshot.settings.nick;
  if (maxImageInput) maxImageInput.value = snapshot.settings.max_image_kb;
  if (maxPayloadInput) maxPayloadInput.value = snapshot.settings.max_payload_kb;
  if (supabaseUploadToggle) supabaseUploadToggle.checked = !!snapshot.settings.supabase_upload;
  if (supabaseUrlInput) {
    supabaseUrlInput.value = snapshot.settings.supabase_url || DEFAULT_SUPABASE_URL || "";
  }
  if (supabaseAnonKeyInput) {
    supabaseAnonKeyInput.value =
      snapshot.settings.supabase_anon_key || DEFAULT_SUPABASE_ANON_KEY || "";
  }
  if (supabaseBucketInput) supabaseBucketInput.value = snapshot.settings.supabase_bucket || "echochan-images";

  currentRoomEl.textContent = state.currentRoom;
  renderRooms();
  await loadRoomMessages(state.currentRoom);

  if (JSON.stringify(normalizedRooms) !== JSON.stringify(snapshot.settings.rooms)) {
    state.settings.rooms = normalizedRooms;
    await invoke("save_settings", { settings: state.settings });
  }
  updateReplyBar();
  state.isAtBottom = true;
  updateJumpButton();
}

async function loadRoomMessages(room) {
  const list = await invoke("get_room_messages", { room });
  state.roomCounts[room] = list.length;
  renderMessages(list);
  renderRooms();
  if (useSupabase()) {
    subscribeSupabaseRoom(room);
    startPolling(room);
  }
}

async function connectRelays() {
  setStatus("Supabase connected");
  showStatusBanner("Supabase connected");
  showToast("Connected to Supabase.", "info", 2500);
}

async function handleCommand(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (trimmed.startsWith("/join ")) {
    const room = normalizeRoom(trimmed.replace("/join", "").trim());
    if (!room) return;
    if (!state.rooms.includes(room)) {
      state.rooms.push(room);
      renderRooms();
      await invoke("add_room", { room });
    }
    state.currentRoom = room;
    currentRoomEl.textContent = room;
    addSystemMessage(`Joined ${room}.`);
    await loadRoomMessages(room);
    return;
  }
  if (trimmed.startsWith("/leave ")) {
    const room = normalizeRoom(trimmed.replace("/leave", "").trim());
    if (!room) return;
    if (state.rooms.length <= 1) {
      setStatus("At least one room must remain.");
      return;
    }
    if (!state.rooms.includes(room)) {
      setStatus("Room not found.");
      return;
    }
    await invoke("remove_room", { room });
    state.rooms = state.rooms.filter((r) => r !== room);
    if (state.currentRoom === room) {
      state.currentRoom = state.rooms[0];
      currentRoomEl.textContent = state.currentRoom;
      await loadRoomMessages(state.currentRoom);
    }
    renderRooms();
    addSystemMessage(`Left ${room}.`);
    return;
  }
  if (trimmed.startsWith("/nick ")) {
    const nick = trimmed.replace("/nick", "").trim();
    if (!nick) return;
    state.settings.nick = nick;
    nickInput.value = nick;
    await invoke("save_settings", { settings: state.settings });
    addSystemMessage(`Nick changed to ${nick}.`);
    return;
  }
}

async function handleSend(text) {
  if (state.isSending) return;
  const trimmed = text.trim();
  if (!trimmed && !state.attachments.length) return;

  if (trimmed.startsWith("/join ") || trimmed.startsWith("/nick ") || trimmed.startsWith("/leave ")) {
    await handleCommand(trimmed);
    messageInput.value = "";
    clearReplyTarget();
    autoResizeTextarea();
    return;
  }

  let action = false;
  let body = trimmed;
  if (trimmed.startsWith("/me ")) {
    action = true;
    body = trimmed.replace("/me", "").trim();
  }

  const reply = state.replyTo
    ? {
        id: state.replyTo.id,
        nick: state.replyTo.nick,
        text: state.replyTo.text,
        ts: state.replyTo.ts
      }
    : null;

  const payloadForEstimate = {
    type: "message",
    room: normalizeRoom(state.currentRoom),
    nick: state.settings.nick,
    createdAtSec: Math.floor(Date.now() / 1000),
    ts: Date.now(),
    text: body,
    attachments: state.attachments,
    id: "0".repeat(64),
    action,
    reply
  };

  if (estimatePayloadKB(payloadForEstimate) > state.maxPayloadKB) {
    setStatus(`Payload exceeds ${state.maxPayloadKB}KB limit.`);
    return;
  }

  try {
    state.isSending = true;
    if (sendBtn) sendBtn.disabled = true;
    const msg = await invoke("send_message", {
      message: {
        room: normalizeRoom(state.currentRoom),
        nick: state.settings.nick,
        text: body,
        attachments: state.attachments,
        action,
        reply
      }
    });
    state.attachments = [];
    clearReplyTarget();
    updateInlinePreviews();
    messageInput.value = "";
    autoResizeTextarea();
    const inserted = insertMessage(msg);
    if (inserted) {
      const room = msg.room || state.currentRoom;
      state.roomCounts[room] = (state.roomCounts[room] || 0) + 1;
      if (room === state.currentRoom) {
        const shouldAutoScroll = isMessagesAtBottom();
        addMessageToDom(msg, { sorted: true });
        if (shouldAutoScroll) {
          scrollMessagesToLatest(true);
        } else {
          state.isAtBottom = false;
          updateJumpButton();
        }
      }
      renderRooms();
    }
  } catch (err) {
    setStatus(String(err));
  } finally {
    state.isSending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

async function processImage(file, maxDim, maxKB) {
  const bitmap = await createImageBitmap(file);
  const maxSide = Math.max(bitmap.width, bitmap.height);
  const baseScale = Math.min(1, maxDim / maxSide);
  const scales = [1, 0.9, 0.8, 0.7, 0.6];
  const qualities = [0.75, 0.6, 0.45, 0.3];

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  for (const scaleFactor of scales) {
    const scale = baseScale * scaleFactor;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);

    for (const quality of qualities) {
      const dataUrl = canvas.toDataURL("image/webp", quality);
      const base64 = dataUrl.split(",")[1] || "";
      const size = Math.floor(base64.length * 0.75);
      if (size <= maxKB * 1024) {
        return {
          kind: "inline",
          mime: "image/webp",
          data: dataUrl,
          w: width,
          h: height,
          size
        };
      }
    }
  }
  throw new Error("Image too large after compression.");
}

function isImageFile(file) {
  return file?.type?.startsWith("image/");
}

function sanitizeFilename(name, fallback = "file") {
  const safe = String(name || fallback).trim() || fallback;
  return safe.replace(/[^\w.-]+/g, "_");
}

function toMB(bytes) {
  return bytes / (1024 * 1024);
}

function inferAttachmentMime(att) {
  const raw = String(att?.mime || "").toLowerCase();
  if (raw) return raw;
  const name = String(att?.name || "").toLowerCase();
  const data = String(att?.data || "");
  if (data.startsWith("data:image/")) return data.slice(5, data.indexOf(";"));
  return "";
}

async function uploadImageToSupabase(dataUrl, filename) {
  const url = state.settings.supabase_url;
  const key = state.settings.supabase_anon_key;
  const bucket = state.settings.supabase_bucket;
  if (!url || !key || !bucket) {
    throw new Error("Supabase upload is enabled but credentials are missing.");
  }
  const base64 = (dataUrl.split(",")[1] || "").trim();
  if (!base64) throw new Error("Invalid image data.");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const safeName = sanitizeFilename(filename || "image");
  const path = `uploads/${Date.now()}_${Math.random().toString(16).slice(2)}_${safeName}.webp`;
  const endpoint = `${url}/storage/v1/object/${bucket}/${path}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": "image/webp",
      "x-upsert": "true"
    },
    body: bytes
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${text}`);
  }
  return `${url}/storage/v1/object/public/${bucket}/${path}`;
}

async function uploadFileToSupabase(file) {
  const url = state.settings.supabase_url;
  const key = state.settings.supabase_anon_key;
  const bucket = state.settings.supabase_bucket;
  if (!url || !key || !bucket) {
    throw new Error("Supabase upload is enabled but credentials are missing.");
  }
  const safeName = sanitizeFilename(file?.name || "media");
  const path = `uploads/${Date.now()}_${Math.random().toString(16).slice(2)}_${safeName}`;
  const endpoint = `${url}/storage/v1/object/${bucket}/${path}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": file?.type || "application/octet-stream",
      "x-upsert": "true"
    },
    body: await file.arrayBuffer()
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upload failed: ${res.status} ${text}`);
  }
  return `${url}/storage/v1/object/public/${bucket}/${path}`;
}

async function handleFiles(files) {
  for (const file of files) {
    if (state.attachments.length >= MAX_ATTACHMENT_COUNT) {
      setStatus(`Only ${MAX_ATTACHMENT_COUNT} attachments allowed.`);
      break;
    }
    try {
    if (isImageFile(file)) {
      const att = await processImage(file, 1280, state.maxImageKB);
      if (state.settings.supabase_upload) {
        setStatus("Uploading image...");
        const url = await uploadImageToSupabase(att.data, file.name || "image");
          state.attachments.push({
            kind: "link",
            mime: att.mime,
            data: url,
            w: att.w,
            h: att.h,
            size: att.size,
            name: file.name || "image.webp"
          });
          setStatus("Image uploaded.");
        } else {
          state.attachments.push({
            ...att,
            name: file.name || "image.webp"
          });
        }
      updateInlinePreviews();
      continue;
    }
    setStatus("Only images are supported.");
    } catch (err) {
      setStatus(String(err));
    }
  }
}

function openSettings() {
  settingsModal.classList.remove("hidden");
}

function closeSettings() {
  settingsModal.classList.add("hidden");
  saveNickImmediate();
}

async function saveSettings({ close = true } = {}) {
  state.settings.nick = nickInput?.value.trim() || state.settings.nick;
  const nextImageKb = Number(maxImageInput?.value) || state.maxImageKB;
  const nextPayloadKb = Number(maxPayloadInput?.value) || state.maxPayloadKB;
  state.settings.max_image_kb = Math.max(20, Math.min(300, nextImageKb));
  state.settings.max_payload_kb = Math.max(60, Math.min(8000, nextPayloadKb));
  state.settings.supabase_upload = !!supabaseUploadToggle?.checked;
  state.settings.supabase_url = supabaseUrlInput?.value.trim() || "";
  state.settings.supabase_anon_key = supabaseAnonKeyInput?.value.trim() || "";
  state.settings.supabase_bucket = supabaseBucketInput?.value.trim() || "echochan-images";
  if (maxImageInput) maxImageInput.value = String(state.settings.max_image_kb);
  if (maxPayloadInput) maxPayloadInput.value = String(state.settings.max_payload_kb);
  state.maxImageKB = state.settings.max_image_kb;
  state.maxPayloadKB = state.settings.max_payload_kb;
  await invoke("save_settings", { settings: state.settings });
  if (close) {
    closeSettings();
  }
  await connectRelays();
}

async function saveNickImmediate() {
  if (!nickInput) return;
  const next = nickInput.value.trim() || "Anonymous";
  if (next === state.settings.nick) return;
  state.settings.nick = next;
  await invoke("save_settings", { settings: state.settings });
}



connectBtn.addEventListener("click", async () => {
  const room = normalizeRoom(commandInput.value);
  if (!room) return;
  if (!state.rooms.includes(room)) {
    state.rooms.push(room);
    renderRooms();
    await invoke("add_room", { room });
  }
  state.currentRoom = room;
  currentRoomEl.textContent = room;
  addSystemMessage(`Joined ${room}.`);
  await loadRoomMessages(room);
  commandInput.value = "";
});
settingsBtn.addEventListener("click", openSettings);
settingsClose.addEventListener("click", closeSettings);
settingsSave.addEventListener("click", saveSettings);
nickInput?.addEventListener("blur", saveNickImmediate);
nickInput?.addEventListener("change", saveNickImmediate);
settingsModal.addEventListener("click", (evt) => {
  if (evt.target === settingsModal) closeSettings();
});
confirmOk.addEventListener("click", () => closeConfirm(true));
confirmCancel.addEventListener("click", () => closeConfirm(false));
confirmModal.addEventListener("click", (evt) => {
  if (evt.target === confirmModal) closeConfirm(false);
});
imageViewer.addEventListener("click", () => {
  closeImageViewer();
});
sidebarToggle?.addEventListener("click", () => {
  if (window.innerWidth <= 900) {
    document.body.classList.toggle("sidebar-open");
  } else {
    document.body.classList.toggle("sidebar-collapsed");
  }
});
sidebarOverlay?.addEventListener("click", () => {
  document.body.classList.remove("sidebar-open");
});
attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (evt) => {
  const files = Array.from(evt.target.files || []);
  await handleFiles(files);
  fileInput.value = "";
});

commandInput.addEventListener("keydown", async (evt) => {
  if (evt.key === "Enter") {
    evt.preventDefault();
    connectBtn.click();
  }
});

sendBtn.addEventListener("click", async () => handleSend(messageInput.value));
messageInput.addEventListener("keydown", async (evt) => {
  if (evt.key === "Enter" && !evt.shiftKey) {
    evt.preventDefault();
    await handleSend(messageInput.value);
  }
});

messageInput.addEventListener("paste", async (evt) => {
  const items = evt.clipboardData?.items;
  if (!items) return;
  const images = [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) images.push(file);
    }
  }
  if (!images.length) return;
  evt.preventDefault();
  await handleFiles(images);
});

messageInput.addEventListener("input", autoResizeTextarea);
messagesEl.addEventListener("scroll", () => {
  state.isAtBottom = isMessagesAtBottom();
  updateJumpButton();
  if (toolbar) {
    const currentTop = messagesEl.scrollTop;
    const isScrollingDown = currentTop > lastMessagesScrollTop + 6;
    const isScrollingUp = currentTop < lastMessagesScrollTop - 6;
    if (isScrollingDown && currentTop > 20) {
      toolbar.classList.add("hidden");
    } else if (isScrollingUp || currentTop <= 10) {
      toolbar.classList.remove("hidden");
    }
    lastMessagesScrollTop = currentTop;
  }
});
jumpLatest?.addEventListener("click", () => {
  scrollMessagesToLatest(true);
});
replyCancel?.addEventListener("click", () => {
  clearReplyTarget();
});
npPlay?.addEventListener("click", () => {
  if (audioManager.isPlaying()) {
    audioManager.pauseCurrent();
  } else {
    audioManager.playCurrent();
  }
});
npStop?.addEventListener("click", () => audioManager.stopCurrent());
npSwitch?.addEventListener("click", () => audioManager.switchSource());
document.addEventListener("keydown", (evt) => {
  if (evt.key === "Escape" && !confirmModal.classList.contains("hidden")) {
    closeConfirm(false);
  }
  if (evt.key === "Escape" && !imageViewer.classList.contains("hidden")) {
    closeImageViewer();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    pollNewMessages(state.currentRoom);
  }
});

listen("new-message", (event) => {
  const msg = event.payload;
  if (!msg || !msg.room) return;
  if (!state.roomCounts[msg.room]) state.roomCounts[msg.room] = 0;
  state.roomCounts[msg.room] += 1;
  if (msg.room === state.currentRoom) {
    const shouldAutoScroll = isMessagesAtBottom();
    addMessageToDom(msg, { sorted: true });
    if (shouldAutoScroll) {
      scrollMessagesToLatest(true);
    } else {
      state.isAtBottom = false;
      updateJumpButton();
    }
  }
  renderRooms();
});

loadState().then(connectRelays).catch((err) => setStatus(String(err)));
autoResizeTextarea();
