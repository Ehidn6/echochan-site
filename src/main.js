import "./style.css";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { createClient } from "@supabase/supabase-js";

const DEFAULT_SUPABASE_URL = "https://nuildqmtkmzcwkgfnqki.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "sb_publishable_QEjAIv_oVtq7M73mnTRqOA_kGM8tKhr";

const el = (id) => document.getElementById(id);

const state = {
  settings: null,
  currentRoom: "#test",
  rooms: [],
  roomCounts: {},
  attachments: [],
  maxImageKB: 300,
  maxPayloadKB: 450,
  peers: new Map(),
  sessions: new Map(),
  pendingOffers: new Map(),
  lastRelayNotice: "",
  lastRelayDetail: "",
  pendingRelayDetail: false,
  relayPollId: null,
  relayItems: [],
  messagePollId: null,
  lastMessageId: new Map(),
  initialBuffering: false,
  bufferedMessages: [],
  bufferTimer: null,
  replyTo: null,
  isAtBottom: true
};

const relayConnections = new Map();
const messagesByRoom = new Map();
const seenIds = new Set();
const messageIndex = new Map();
let subscriptionId = "echochan-web";
let supabaseClient = null;
let supabaseChannel = null;

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
    case "connect_relays":
      return connectRelaysInternal();
    case "send_message":
      return sendMessageInternal(payload.message);
    case "send_signal":
      return sendSignalInternal(payload.signal);
    case "check_tor":
      throw new Error("Tor is not supported in the web build.");
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
const p2pBtn = el("p2p-btn");
const settingsBtn = el("settings-btn");
const settingsModal = el("settings-modal");
const settingsContent = settingsModal?.querySelector(".modal-content");
const settingsClose = el("settings-close");
const settingsSave = el("settings-save");
const relayTest = el("relay-test");
const relayDefaults = el("relay-defaults");
const torCheck = el("tor-check");
const relayPrune = el("relay-prune");
const relayStatusList = el("relay-status-list");
const confirmModal = el("confirm-modal");
const confirmTitle = el("confirm-title");
const confirmBody = el("confirm-body");
const confirmOk = el("confirm-ok");
const confirmCancel = el("confirm-cancel");
const nickInput = el("nick-input");
const relayInput = el("relay-input");
const stunInput = el("stun-input");
const turnInput = el("turn-input");
const turnUsernameInput = el("turn-username");
const turnPasswordInput = el("turn-password");
const maxImageInput = el("max-image-kb");
const maxPayloadInput = el("max-payload-kb");
const supabaseUploadToggle = el("supabase-upload-toggle");
const supabaseUrlInput = el("supabase-url");
const supabaseAnonKeyInput = el("supabase-anon-key");
const supabaseBucketInput = el("supabase-bucket");
const torToggle = el("tor-toggle");
const proxyInput = el("proxy-input");
const maxP2pInput = el("max-p2p-mb");
const p2pTimeoutInput = el("p2p-timeout");
const p2pRecentInput = el("p2p-recent-min");
const p2pMaxSessionsInput = el("p2p-max-sessions");
const fileInput = el("file-input");
const p2pFileInput = el("p2p-file-input");
const targetSelect = el("target-select");
const p2pInbox = el("p2p-inbox");
const relayErrors = el("relay-errors");
const toastStack = el("toast-stack");
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

const CHUNK_SIZE = 16 * 1024;
const MESSAGE_MIN_HEIGHT = 44;
const MESSAGE_MAX_HEIGHT = 220;
const MESSAGE_FLOW_REVERSE = false;
const P2P_ENABLED = false;

let confirmResolver = null;
const DEFAULT_RELAYS = [
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://nostr.oxtr.dev",
  "wss://www.nostr.ltd"
];

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

function sanitizeRelayLines(lines) {
  const out = [];
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    const first = trimmed.split(/\s+/)[0];
    const cleaned = first.replace(/[;,]+$/, "");
    if (!cleaned.startsWith("wss://")) continue;
    out.push(cleaned);
  }
  return out;
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
    relays: [...DEFAULT_RELAYS],
    rooms: ["#echo"],
    max_image_kb: 200,
    max_payload_kb: 300,
    supabase_upload: false,
    supabase_url: DEFAULT_SUPABASE_URL,
    supabase_anon_key: DEFAULT_SUPABASE_ANON_KEY,
    supabase_bucket: "echochan-images",
    stun_urls: ["stun:stun.l.google.com:19302"],
    turn_urls: [],
    turn_username: "",
    turn_password: "",
    max_p2p_mb: 5,
    p2p_timeout_sec: 15,
    p2p_recent_minutes: 10,
    p2p_max_sessions: 2,
    nostr_pubkey: "",
    nostr_privkey: "",
    client_id: "",
    use_tor: false,
    proxy_url: ""
  };
}

function generateKeys() {
  const priv = secp256k1.utils.randomPrivateKey();
  const pub = schnorr.getPublicKey(priv);
  return {
    priv: bytesToHex(priv),
    pub: bytesToHex(pub)
  };
}

function ensureKeys(settings) {
  if (!settings.nostr_privkey || !settings.nostr_pubkey) {
    const keys = generateKeys();
    settings.nostr_privkey = keys.priv;
    settings.nostr_pubkey = keys.pub;
  }
  settings.client_id = settings.nostr_pubkey;
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
  settings.relays = sanitizeRelayLines(settings.relays || []);
  settings.rooms = normalizeRooms(settings.rooms || []);
  if (!settings.rooms.length) settings.rooms = ["#echo"];
  ensureKeys(settings);
  return settings;
}

function saveSettingsToStorage(settings) {
  localStorage.setItem("echochan_settings", JSON.stringify(settings));
}

function buildSubscriptionId(pubkey) {
  const suffix = (pubkey || "").slice(0, 8);
  return `echochan-${suffix || "web"}`;
}

function getCreatedAtSec(msg) {
  if (msg && typeof msg.createdAtSec === "number") return msg.createdAtSec;
  const ts = Number(msg?.ts || msg?.receivedAtMs || 0);
  return ts ? Math.floor(ts / 1000) : 0;
}

function computeMessageId(msg) {
  const attachmentsJson = JSON.stringify(msg.attachments || []);
  const replyJson = JSON.stringify(msg.reply || null);
  const createdAtSec = getCreatedAtSec(msg);
  const input = `${msg.room}${msg.nick}${createdAtSec}${msg.text}${attachmentsJson}${replyJson}`;
  const hash = sha256(utf8ToBytes(input));
  return bytesToHex(hash);
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

function startInitialBuffer() {
  state.initialBuffering = true;
  state.bufferedMessages = [];
  if (state.bufferTimer) clearTimeout(state.bufferTimer);
  state.bufferTimer = setTimeout(() => flushInitialBuffer(), 800);
}

function normalizeIncomingMessage(msg) {
  if (!msg) return null;
  if (!msg.id) msg.id = computeMessageId(msg);
  if (!msg.createdAtSec) msg.createdAtSec = getCreatedAtSec(msg);
  if (!msg.receivedAtMs) msg.receivedAtMs = nowMs();
  if (seenIds.has(msg.id)) return null;
  seenIds.add(msg.id);
  return msg;
}

function flushInitialBuffer() {
  state.initialBuffering = false;
  const buffer = state.bufferedMessages || [];
  state.bufferedMessages = [];
  if (!buffer.length) {
    updateJumpButton();
    return;
  }
  buffer.sort(compareMessages);
  const shouldAutoScroll = isMessagesAtBottom();
  const currentRoom = state.currentRoom;
  buffer.forEach((msg) => {
    const list = messagesByRoom.get(msg.room) || [];
    list.push(msg);
    list.sort(compareMessages);
    if (list.length > 500) {
      const removed = list.shift();
      if (removed?.id) messageIndex.delete(removed.id);
    }
    messagesByRoom.set(msg.room, list);
    if (msg?.id) messageIndex.set(msg.id, msg);
    state.roomCounts[msg.room] = list.length;
    if (msg.room === currentRoom) {
      addMessageToDom(msg, { sorted: true });
    }
  });
  renderRooms();
  if (shouldAutoScroll) scrollMessagesToLatest(true);
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

function nostrEventId(pubkey, createdAt, kind, tags, content) {
  const payload = JSON.stringify([0, pubkey, createdAt, kind, tags, content]);
  const hash = sha256(utf8ToBytes(payload));
  return bytesToHex(hash);
}

async function buildNostrEvent(settings, kind, tags, content, createdAtSec) {
  const pubkey = settings.nostr_pubkey;
  const id = nostrEventId(pubkey, createdAtSec, kind, tags, content);
  const sigBytes = await schnorr.sign(hexToBytes(id), hexToBytes(settings.nostr_privkey));
  const sig = bytesToHex(sigBytes);
  return {
    id,
    pubkey,
    created_at: createdAtSec,
    kind,
    tags,
    content,
    sig
  };
}

function roomTag(room) {
  return room.trim().replace(/^#/, "");
}

function buildSubscriptionRequest() {
  const rooms = state.settings.rooms || [];
  const tagValues = rooms.map((r) => roomTag(r));
  if (!tagValues.length) return null;
  const filter = { kinds: [1, 42], "#t": tagValues };
  return JSON.stringify(["REQ", subscriptionId, filter]);
}

function buildCloseRequest() {
  return JSON.stringify(["CLOSE", subscriptionId]);
}

function updateRelaySummaryFromState() {
  const items = Array.from(relayConnections.values()).map((relay) => ({
    url: relay.url,
    state: relay.status,
    last_error: relay.lastError || null
  }));
  const connected = items.filter((i) => i.state === "connected").length;
  const errors = items.filter((i) => i.state === "error").length;
  const summary = {
    total: items.length,
    connected,
    errors,
    items
  };
  emitEvent("relay-status", summary);
  return summary;
}

function connectAllRelays() {
  const nextRelays = sanitizeRelayLines(state.settings.relays || []);
  const keep = new Set(nextRelays);
  for (const [url, relay] of relayConnections.entries()) {
    if (!keep.has(url)) {
      relay.ws?.close();
      relayConnections.delete(url);
    }
  }
  for (const url of nextRelays) {
    if (!relayConnections.has(url)) {
      relayConnections.set(url, {
        url,
        status: "connecting",
        lastError: null,
        backoff: 1000,
        ws: null,
        timer: null
      });
    }
    connectRelay(url);
  }
  return updateRelaySummaryFromState();
}

function connectRelay(url) {
  const relay = relayConnections.get(url);
  if (!relay) return;
  if (relay.ws && (relay.ws.readyState === WebSocket.OPEN || relay.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  relay.status = "connecting";
  relay.lastError = null;
  updateRelaySummaryFromState();
  try {
    const ws = new WebSocket(url);
    relay.ws = ws;
    ws.onopen = () => {
      relay.status = "connected";
      relay.lastError = null;
      relay.backoff = 1000;
      const req = buildSubscriptionRequest();
      if (req) ws.send(req);
      updateRelaySummaryFromState();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        handleIncoming(event.data, url);
      }
    };
    ws.onerror = () => {
      relay.status = "error";
      relay.lastError = relay.lastError || "WebSocket error";
      updateRelaySummaryFromState();
    };
    ws.onclose = () => {
      relay.status = "reconnecting";
      updateRelaySummaryFromState();
      const delay = Math.min(relay.backoff, 30000);
      relay.backoff = Math.min(relay.backoff * 2, 30000);
      clearTimeout(relay.timer);
      relay.timer = setTimeout(() => connectRelay(url), delay);
    };
  } catch (err) {
    relay.status = "error";
    relay.lastError = String(err);
    updateRelaySummaryFromState();
  }
}

function broadcastPayload(payload) {
  relayConnections.forEach((relay) => {
    if (relay.ws && relay.ws.readyState === WebSocket.OPEN) {
      relay.ws.send(payload);
    }
  });
}

function resubscribeRelays() {
  if (useSupabase()) {
    subscribeSupabaseRoom(state.currentRoom);
    return;
  }
  const close = buildCloseRequest();
  broadcastPayload(close);
  const req = buildSubscriptionRequest();
  if (req) broadcastPayload(req);
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

function handleIncoming(raw, relayUrl) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(value) || !value.length) return;
  const kind = value[0];
  if (kind === "NOTICE") {
    const msg = value[1] || "";
    const relay = relayConnections.get(relayUrl);
    if (relay) {
      relay.lastError = msg || "NOTICE";
      relay.status = relay.status === "connected" ? "connected" : "error";
      updateRelaySummaryFromState();
    }
    return;
  }
  if (kind === "OK") {
    const ok = value[2] !== false;
    if (!ok) {
      const msg = value[3] || "event rejected";
      const relay = relayConnections.get(relayUrl);
      if (relay) {
        relay.lastError = msg;
        updateRelaySummaryFromState();
      }
    }
    return;
  }
  if (kind !== "EVENT" || value.length < 3) return;
  const event = value[2];
  if (!event || (event.kind !== 1 && event.kind !== 42)) return;
  let content;
  try {
    content = JSON.parse(event.content);
  } catch {
    return;
  }
  if (!content || typeof content !== "object") return;
  if (content.type === "signal") {
    const signal = {
      type: "signal",
      room: normalizeRoom(content.room || "") || roomFromTags(event.tags),
      from: content.from || event.pubkey,
      to: content.to || null,
      sid: content.sid,
      kind: content.kind,
      sdp: content.sdp || null,
      candidate: content.candidate || null,
      ts: content.ts || (event.created_at * 1000)
    };
    emitEvent("signal-message", signal);
    return;
  }
  if (content.type !== "message") return;
  const room = normalizeRoom(content.room || "") || roomFromTags(event.tags);
  if (!room) return;
  const msg = {
    type: "message",
    room,
    nick: content.nick || `npub:${(event.pubkey || "").slice(0, 8)}`,
    client_id: content.client_id || event.pubkey,
    createdAtSec: Number(event.created_at || 0) || Math.floor(Date.now() / 1000),
    ts: Number(event.created_at || 0) * 1000 || Date.now(),
    text: content.text || "",
    attachments: Array.isArray(content.attachments) ? content.attachments : [],
    id: event.id,
    action: !!content.action,
    reply:
      content.reply && typeof content.reply === "object"
        ? content.reply
        : null
  };
  msg.receivedAtMs = nowMs();
  const normalized = normalizeIncomingMessage(msg);
  if (!normalized) return;
  if (state.initialBuffering) {
    state.bufferedMessages.push(normalized);
    return;
  }
  if (insertMessage(normalized)) {
    emitEvent("new-message", normalized);
  }
}

function roomFromTags(tags = []) {
  for (const tag of tags) {
    if (tag && tag[0] === "t" && tag[1]) {
      return normalizeRoom(tag[1]);
    }
  }
  return "";
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
  return true;
}

async function getStateSnapshot() {
  const counts = {};
  messagesByRoom.forEach((list, room) => {
    counts[room] = list.length;
  });
  return {
    settings: state.settings,
    counts,
    relay_summary: updateRelaySummaryFromState()
  };
}

async function saveSettingsInternal(settings) {
  const next = { ...state.settings, ...settings };
  next.relays = sanitizeRelayLines(next.relays || []);
  next.rooms = normalizeRooms(next.rooms || []);
  if (!next.rooms.length) next.rooms = ["#echo"];
  ensureKeys(next);
  state.settings = next;
  subscriptionId = buildSubscriptionId(next.nostr_pubkey);
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

async function connectRelaysInternal() {
  if (useSupabase()) {
    return { total: 1, connected: 1, errors: 0, items: [] };
  }
  return connectAllRelays();
}

async function sendMessageInternal(message) {
  if (useSupabase()) {
    if (message.attachments?.length > 2) {
      throw new Error("Only 2 inline images allowed.");
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
  if (message.attachments?.length > 2) {
    throw new Error("Only 2 inline images allowed.");
  }
  const room = normalizeRoom(message.room);
  const createdAtSec = Math.floor(Date.now() / 1000);
  const msg = {
    room,
    type: "message",
    nick: message.nick || "Anonymous",
    client_id: state.settings.nostr_pubkey,
    createdAtSec,
    ts: createdAtSec * 1000,
    text: message.text || "",
    attachments: message.attachments || [],
    id: "",
    action: !!message.action,
    reply: message.reply || null
  };
  msg.id = computeMessageId(msg);
  const content = JSON.stringify(msg);
  const tags = [["t", roomTag(room)]];
  const event = await buildNostrEvent(state.settings, 1, tags, content, createdAtSec);
  msg.id = event.id;
  msg.receivedAtMs = nowMs();
  const payload = JSON.stringify(["EVENT", event]);
  if (payload.length > (state.settings.max_payload_kb || 450) * 1024) {
    throw new Error("Payload exceeds max_payload_kb limit.");
  }
  if (insertMessage(msg)) {
    broadcastPayload(payload);
  }
  return msg;
}

async function sendSignalInternal(signal) {
  const msg = {
    type: "signal",
    room: normalizeRoom(signal.room),
    from: signal.from || state.settings.nostr_pubkey,
    to: signal.to || null,
    sid: signal.sid,
    kind: signal.kind,
    sdp: signal.sdp || null,
    candidate: signal.candidate || null,
    ts: Date.now()
  };
  const content = JSON.stringify(msg);
  const tags = [["t", roomTag(msg.room)]];
  const event = await buildNostrEvent(state.settings, 1, tags, content, Math.floor(msg.ts / 1000));
  const payload = JSON.stringify(["EVENT", event]);
  broadcastPayload(payload);
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

function renderTargetSelect() {
  if (!targetSelect) return;
  targetSelect.innerHTML = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = "All";
  targetSelect.appendChild(option);
  const sorted = Array.from(state.peers.values()).sort((a, b) => a.nick.localeCompare(b.nick));
  for (const peer of sorted) {
    const opt = document.createElement("option");
    opt.value = peer.id;
    opt.textContent = `${peer.nick} · ${peer.id.slice(0, 8)}`;
    targetSelect.appendChild(opt);
  }
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
      const img = document.createElement("img");
      img.src = att.data;
      img.alt = "attachment";
      img.addEventListener("click", () => openImageViewer(att.data));
      mediaColumn.appendChild(img);
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
    const img = document.createElement("img");
    img.src = att.data;
    inlinePreviews.appendChild(img);
  });
}

function estimatePayloadKB(payload) {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json).length;
  return bytes / 1024;
}

async function loadState() {
  state.settings = loadSettingsFromStorage();
  subscriptionId = buildSubscriptionId(state.settings.nostr_pubkey);
  const snapshot = await invoke("get_state", {});
  state.settings = snapshot.settings;
  const normalizedRooms = normalizeRooms(snapshot.settings.rooms);
  state.rooms = normalizedRooms;
  state.roomCounts = snapshot.counts || {};
  state.currentRoom = state.rooms[0] || "#test";
  state.maxImageKB = snapshot.settings.max_image_kb;
  state.maxPayloadKB = snapshot.settings.max_payload_kb;

  if (nickInput) nickInput.value = snapshot.settings.nick;
  if (relayInput) relayInput.value = snapshot.settings.relays.join("\n");
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
  if (stunInput) stunInput.value = snapshot.settings.stun_urls?.join("\n") || "";
  if (torToggle) torToggle.checked = snapshot.settings.use_tor || false;
  if (proxyInput) proxyInput.value = snapshot.settings.proxy_url || "";
  if (turnInput) turnInput.value = snapshot.settings.turn_urls?.join("\n") || "";
  if (turnUsernameInput) turnUsernameInput.value = snapshot.settings.turn_username || "";
  if (turnPasswordInput) turnPasswordInput.value = snapshot.settings.turn_password || "";
  if (maxP2pInput) maxP2pInput.value = snapshot.settings.max_p2p_mb || 5;
  if (p2pTimeoutInput) p2pTimeoutInput.value = snapshot.settings.p2p_timeout_sec || 15;
  if (p2pRecentInput) p2pRecentInput.value = snapshot.settings.p2p_recent_minutes || 10;
  if (p2pMaxSessionsInput) p2pMaxSessionsInput.value = snapshot.settings.p2p_max_sessions || 2;

  currentRoomEl.textContent = state.currentRoom;
  renderRooms();
  if (targetSelect) renderTargetSelect();
  await loadRoomMessages(state.currentRoom);
  updateRelaySummary(snapshot.relay_summary);

  if (JSON.stringify(normalizedRooms) !== JSON.stringify(snapshot.settings.rooms)) {
    state.settings.rooms = normalizedRooms;
    await invoke("save_settings", { settings: state.settings });
  }
  addSystemMessage(`Relays configured: ${state.settings.relays.length}`);
  updateReplyBar();
  state.isAtBottom = true;
  updateJumpButton();
  startRelayPolling();
  startMessagePolling();
}

function startRelayPolling() {
  if (state.relayPollId) return;
  state.relayPollId = setInterval(async () => {
    try {
      const snapshot = await invoke("get_state", {});
      if (snapshot && snapshot.relay_summary) {
        updateRelaySummary(snapshot.relay_summary);
      }
    } catch {
      // ignore poll errors
    }
  }, 4000);
}

function startMessagePolling() {
  if (useSupabase()) return;
  if (state.messagePollId) return;
  state.messagePollId = setInterval(async () => {
    if (!state.currentRoom) return;
    try {
      const list = await invoke("get_room_messages", { room: state.currentRoom });
      if (!list.length) return;
      const newItems = [];
      for (const msg of list) {
        if (!msg?.id) continue;
        if (seenIds.has(msg.id)) continue;
        msg.receivedAtMs = msg.receivedAtMs || nowMs();
        seenIds.add(msg.id);
        newItems.push(msg);
      }
      if (!newItems.length) return;
      newItems.sort(compareMessages);
      const shouldAutoScroll = isMessagesAtBottom();
      newItems.forEach((msg) => {
        msg.createdAtSec = msg.createdAtSec || getCreatedAtSec(msg);
        msg.receivedAtMs = msg.receivedAtMs || nowMs();
        const listForRoom = messagesByRoom.get(msg.room) || [];
        listForRoom.push(msg);
        listForRoom.sort(compareMessages);
        if (listForRoom.length > 500) {
          const removed = listForRoom.shift();
          if (removed?.id) messageIndex.delete(removed.id);
        }
        messagesByRoom.set(msg.room, listForRoom);
        if (msg?.id) messageIndex.set(msg.id, msg);
        state.roomCounts[msg.room] = listForRoom.length;
        if (msg.room === state.currentRoom) {
          addMessageToDom(msg, { sorted: true });
        }
      });
      state.roomCounts[state.currentRoom] = list.length;
      const last = list[list.length - 1];
      if (last?.id) state.lastMessageId.set(state.currentRoom, last.id);
      syncPeers(newItems);
      renderRooms();
      if (shouldAutoScroll) scrollMessagesToLatest(true);
    } catch {
      // ignore polling errors
    }
  }, 2000);
}

function updateRelaySummary(summary) {
  if (!summary) return;
  const total = summary.total ?? (summary.items ? summary.items.length : 0);
  const connected = summary.connected ?? 0;
  const errors = summary.errors ?? 0;
  state.relayItems = summary.items || [];
  if (total > 0 && connected === 0 && errors === 0) {
    setStatus(`Connecting to ${total} relays...`);
  } else if (connected > 0) {
    setStatus(`Connected to ${connected}/${total} relays, ${errors} errors`);
  } else {
    setStatus(`Connected to 0 relays, ${errors} errors`);
  }
  renderRelayStatusList(summary.items || []);
  renderRelayErrors(summary.items || []);
  emitRelayNotice(summary);
  if (state.pendingRelayDetail) {
    emitRelayDetail(summary);
  }
}

function emitRelayNotice(summary) {
  const parts = [];
  if (summary.total === 0) {
    parts.push("No relays configured. Open Settings and add wss:// relays.");
  } else if (summary.connected === 0) {
    parts.push("No relay connections yet. Check relay errors in Settings.");
  }
  const errorItems = (summary.items || []).filter((item) => item.last_error);
  if (errorItems.length) {
    for (const item of errorItems) {
      if (item.last_error) {
        parts.push(`${item.url} error: ${item.last_error}`);
      } else {
        parts.push(`${item.url} error`);
      }
    }
  }
  if (!parts.length) return;
  const message = parts.join(" ");
  if (message === state.lastRelayNotice) return;
  state.lastRelayNotice = message;
  showToast(message, "error");
}

function emitRelayDetail(summary) {
  const items = summary.items || [];
  if (!items.length) return;
  const lines = items.map((item) => {
    if (item.last_error) {
      return `${item.state}: ${item.url} (${item.last_error})`;
    }
    return `${item.state}: ${item.url}`;
  });
  const message = `Relay status: ${lines.join(" | ")}`;
  if (message === state.lastRelayDetail) return;
  state.lastRelayDetail = message;
  showToast(message, "info", 5000);
  state.pendingRelayDetail = false;
}

function renderRelayStatusList(items) {
  const preserveScroll =
    settingsContent && !settingsModal.classList.contains("hidden");
  const prevScrollTop = preserveScroll ? settingsContent.scrollTop : 0;
  if (!relayStatusList) return;
  relayStatusList.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("div");
    empty.textContent = "No relay status yet. Click Test relays.";
  relayStatusList.appendChild(empty);
    if (preserveScroll) settingsContent.scrollTop = prevScrollTop;
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "relay-status-item";
    const url = document.createElement("div");
    url.textContent = item.url;
    const stateBadge = document.createElement("div");
    stateBadge.className = `state ${item.state}`;
    stateBadge.textContent = item.state;
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      const next = state.settings.relays.filter((r) => r !== item.url);
      if (!next.length) {
        setStatus("At least one relay must remain.");
        return;
      }
      relayInput.value = next.join("\n");
      await saveSettings({ close: false });
    });
    row.append(url, stateBadge, remove);
    if (item.last_error) {
      const err = document.createElement("div");
      err.className = "error";
      err.textContent = item.last_error;
      row.appendChild(err);
    }
    relayStatusList.appendChild(row);
  });
  if (preserveScroll) settingsContent.scrollTop = prevScrollTop;
}

function renderRelayErrors(items) {
  const errorItems = items.filter((item) => item.last_error);
  relayErrors.innerHTML = "";
  if (!errorItems.length) {
    relayErrors.classList.add("hidden");
    return;
  }
  relayErrors.classList.remove("hidden");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "Relay errors";
  relayErrors.appendChild(title);
  errorItems.forEach((item) => {
    const line = document.createElement("div");
    line.className = "item";
    line.textContent = item.last_error
      ? `${item.url} — ${item.last_error}`
      : `${item.url} — error`;
    relayErrors.appendChild(line);
  });
}

async function loadRoomMessages(room) {
  const list = await invoke("get_room_messages", { room });
  state.roomCounts[room] = list.length;
  renderMessages(list);
  syncPeers(list);
  renderRooms();
  if (useSupabase()) {
    subscribeSupabaseRoom(room);
  }
}

async function connectRelays() {
  if (useSupabase()) {
    setStatus("Supabase connected");
    showToast("Connected to Supabase.", "info", 2500);
    return;
  }
  setStatus("Connecting...");
  showToast("Connecting to relays...", "info", 3000);
  startInitialBuffer();
  if (state.settings?.use_tor) {
    const proxy = state.settings.proxy_url || "socks5://127.0.0.1:9150";
    showToast(`Using SOCKS5 proxy: ${proxy}`, "info", 4000);
  }
  state.pendingRelayDetail = true;
  try {
    const summary = await invoke("connect_relays", {});
    updateRelaySummary(summary);
    const total = summary.total ?? (summary.items ? summary.items.length : 0);
    const connected = summary.connected ?? 0;
    const errors = summary.errors ?? 0;
    if (total > 0 && connected === 0 && errors === 0) {
      showToast(`Connecting to chat...`, "info", 3000);
    } else {
      showToast(`Connected to chat.`, "info", 3000);
    }
  } catch (err) {
    setStatus(String(err));
    showToast(String(err), "error", 5000);
  }
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
  const trimmed = text.trim();
  if (!trimmed) return;

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
    state.roomCounts[state.currentRoom] = (state.roomCounts[state.currentRoom] || 0) + 1;
    addMessageToDom(msg);
    renderRooms();
    scrollMessagesToLatest(true);
  } catch (err) {
    setStatus(String(err));
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

async function uploadToSupabase(dataUrl, filename) {
  const url = state.settings.supabase_url;
  const key = state.settings.supabase_anon_key;
  const bucket = state.settings.supabase_bucket;
  if (!url || !key || !bucket) {
    throw new Error("Supabase upload is enabled but credentials are missing.");
  }
  const base64 = (dataUrl.split(",")[1] || "").trim();
  if (!base64) throw new Error("Invalid image data.");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const safeName = String(filename || "image").replace(/[^\w.-]+/g, "_");
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

async function handleFiles(files) {
  for (const file of files) {
    if (state.attachments.length >= 2) {
      setStatus("Only 2 inline images allowed.");
      break;
    }
    try {
      const att = await processImage(file, 1280, state.maxImageKB);
      if (state.settings.supabase_upload) {
        setStatus("Uploading image...");
        const url = await uploadToSupabase(att.data, file.name || "image");
        state.attachments.push({
          kind: "link",
          mime: att.mime,
          data: url,
          w: att.w,
          h: att.h,
          size: att.size
        });
        setStatus("Image uploaded.");
      } else {
        state.attachments.push(att);
      }
      updateInlinePreviews();
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
  const relays = sanitizeRelayLines((relayInput?.value || "").split("\n"));
  const stunUrls = (stunInput?.value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length);
  const turnUrls = (turnInput?.value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length);
  state.settings.nick = nickInput?.value.trim() || state.settings.nick;
  state.settings.relays = relays;
  if (relayInput) relayInput.value = relays.join("\n");
  const nextImageKb = Number(maxImageInput?.value) || state.maxImageKB;
  const nextPayloadKb = Number(maxPayloadInput?.value) || state.maxPayloadKB;
  state.settings.max_image_kb = Math.max(20, Math.min(300, nextImageKb));
  state.settings.max_payload_kb = Math.max(60, Math.min(450, nextPayloadKb));
  state.settings.supabase_upload = !!supabaseUploadToggle?.checked;
  state.settings.supabase_url = supabaseUrlInput?.value.trim() || "";
  state.settings.supabase_anon_key = supabaseAnonKeyInput?.value.trim() || "";
  state.settings.supabase_bucket = supabaseBucketInput?.value.trim() || "echochan-images";
  if (maxImageInput) maxImageInput.value = String(state.settings.max_image_kb);
  if (maxPayloadInput) maxPayloadInput.value = String(state.settings.max_payload_kb);
  state.settings.stun_urls = stunUrls;
  state.settings.use_tor = torToggle?.checked || false;
  state.settings.proxy_url = proxyInput?.value.trim() || "";
  state.settings.turn_urls = turnUrls;
  state.settings.turn_username = turnUsernameInput?.value || "";
  state.settings.turn_password = turnPasswordInput?.value || "";
  state.settings.max_p2p_mb = Number(maxP2pInput?.value) || 5;
  state.settings.p2p_timeout_sec = Number(p2pTimeoutInput?.value) || 15;
  state.settings.p2p_recent_minutes = Number(p2pRecentInput?.value) || 10;
  state.settings.p2p_max_sessions = Number(p2pMaxSessionsInput?.value) || 2;
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

function buildRtcConfig() {
  const iceServers = [];
  if (state.settings.stun_urls && state.settings.stun_urls.length) {
    iceServers.push({ urls: state.settings.stun_urls });
  }
  if (state.settings.turn_urls && state.settings.turn_urls.length) {
    iceServers.push({
      urls: state.settings.turn_urls,
      username: state.settings.turn_username || undefined,
      credential: state.settings.turn_password || undefined
    });
  }
  return { iceServers };
}

function activeSessionsCount() {
  return state.sessions.size;
}

function isRecentSender(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return false;
  const ageMs = nowMs() - peer.lastSeen;
  return ageMs <= (state.settings.p2p_recent_minutes || 10) * 60 * 1000;
}

function syncPeers(messages) {
  if (!targetSelect) return;
  for (const msg of messages) {
    if (!msg.client_id) continue;
    const id = msg.client_id;
    const existing = state.peers.get(id);
    const nick = msg.nick || id.slice(0, 8);
    const lastSeen = (msg.createdAtSec || getCreatedAtSec(msg)) * 1000 || nowMs();
    if (!existing || existing.lastSeen < lastSeen) {
      state.peers.set(id, { id, nick, lastSeen });
    }
  }
  renderTargetSelect();
}

function createSession(sid, mode) {
  const timeoutSec = state.settings.p2p_timeout_sec || 15;
  const session = {
    sid,
    mode,
    pc: null,
    dc: null,
    meta: null,
    receivedChunks: [],
    receivedBytes: 0,
    expectedSize: 0,
    timeout: null
  };
  session.timeout = setTimeout(() => {
    endSession(sid, "P2P failed (timeout). Use inline instead.");
  }, timeoutSec * 1000);
  state.sessions.set(sid, session);
  return session;
}

function endSession(sid, message) {
  const session = state.sessions.get(sid);
  if (!session) return;
  clearTimeout(session.timeout);
  if (session.dc) session.dc.close();
  if (session.pc) session.pc.close();
  state.sessions.delete(sid);
  if (message) setStatus(message);
}

async function sendSignal(kind, payload) {
  const signal = {
    room: state.currentRoom,
    from: state.settings.nostr_pubkey || "",
    to: payload.to || null,
    sid: payload.sid,
    kind,
    sdp: payload.sdp || null,
    candidate: payload.candidate || null
  };
  await invoke("send_signal", { signal });
}

async function startP2PSend(file) {
  if (!P2P_ENABLED) {
    setStatus("P2P is disabled.");
    return;
  }
  if (activeSessionsCount() >= (state.settings.p2p_max_sessions || 2)) {
    setStatus("P2P session limit reached.");
    return;
  }
  if (file.size > (state.settings.max_p2p_mb || 5) * 1024 * 1024) {
    setStatus("P2P file too large.");
    return;
  }

  const sid = randomId();
  const session = createSession(sid, "send");
  const pc = new RTCPeerConnection(buildRtcConfig());
  session.pc = pc;
  const dc = pc.createDataChannel("file");
  session.dc = dc;
  dc.binaryType = "arraybuffer";

  dc.onopen = async () => {
    const arrayBuffer = await file.arrayBuffer();
    const meta = {
      kind: "file_meta",
      sid,
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size
    };
    dc.send(JSON.stringify(meta));
    let offset = 0;
    const buffer = new Uint8Array(arrayBuffer);
    while (offset < buffer.length) {
      const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
      dc.send(chunk);
      offset += CHUNK_SIZE;
    }
  };

  dc.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);
        if (msg.kind === "file_ack" && msg.sid === sid) {
          endSession(sid, "P2P transfer completed.");
        }
      } catch {
        return;
      }
    }
  };

  const targetId = targetSelect?.value || null;
  pc.onicecandidate = async (event) => {
    if (!event.candidate) return;
    await sendSignal("ice", {
      sid,
      to: targetId,
      candidate: {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      }
    });
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal("offer", {
    sid,
    to: targetId,
    sdp: offer.sdp
  });
}

function showOfferCard(signal) {
  const card = document.createElement("div");
  card.className = "p2p-card";
  const label = document.createElement("div");
  label.textContent = `Incoming P2P image from ${signal.from.slice(0, 8)}`;
  const actions = document.createElement("div");
  actions.className = "actions";
  const accept = document.createElement("button");
  accept.textContent = "Accept";
  const decline = document.createElement("button");
  decline.textContent = "Decline";
  actions.append(accept, decline);
  card.append(label, actions);

  const wrapper = document.createElement("div");
  wrapper.className = "message system";
  const body = document.createElement("div");
  body.className = "message-body";
  body.appendChild(card);
  wrapper.appendChild(body);
  messagesEl.appendChild(wrapper);
  scrollMessagesToLatest();

  accept.addEventListener("click", async () => {
    wrapper.remove();
    await acceptOffer(signal);
  });
  decline.addEventListener("click", () => {
    wrapper.remove();
    endSession(signal.sid, "P2P declined.");
  });
}

async function acceptOffer(signal) {
  if (activeSessionsCount() >= (state.settings.p2p_max_sessions || 2)) {
    setStatus("P2P session limit reached.");
    return;
  }
  if (!isRecentSender(signal.from)) {
    const confirmed = await openConfirm({
      title: "Unverified sender",
      body: "Sender has not spoken recently in this room. Accept anyway?",
      okText: "Accept"
    });
    if (!confirmed) {
      endSession(signal.sid, "P2P declined.");
      return;
    }
  }

  const sid = signal.sid;
  const session = createSession(sid, "recv");
  const pc = new RTCPeerConnection(buildRtcConfig());
  session.pc = pc;

  pc.ondatachannel = (event) => {
    const dc = event.channel;
    session.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onmessage = (evt) => handleIncomingData(session, signal.from, evt.data);
  };

  pc.onicecandidate = async (event) => {
    if (!event.candidate) return;
    await sendSignal("ice", {
      sid,
      to: signal.from,
      candidate: {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      }
    });
  };

  await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await sendSignal("answer", {
    sid,
    to: signal.from,
    sdp: answer.sdp
  });
}

function handleIncomingData(session, from, data) {
  if (typeof data === "string") {
    try {
      const meta = JSON.parse(data);
      if (meta.kind === "file_meta" && meta.sid === session.sid) {
        session.meta = meta;
        session.expectedSize = meta.size;
        if (meta.size > (state.settings.max_p2p_mb || 5) * 1024 * 1024) {
          endSession(session.sid, "P2P file too large.");
        }
      }
    } catch {
      return;
    }
    return;
  }

  if (!session.meta) return;
  const chunk = new Uint8Array(data);
  session.receivedChunks.push(chunk);
  session.receivedBytes += chunk.byteLength;

  if (session.receivedBytes >= session.expectedSize) {
    const blob = new Blob(session.receivedChunks, { type: session.meta.mime });
    const url = URL.createObjectURL(blob);
    const message = {
      nick: from.slice(0, 8),
      ts: nowMs(),
      text: "[P2P image]",
      action: false,
      attachments: [{ data: url }]
    };
    addMessageToDom(message);
    scrollMessagesToLatest();
    if (session.dc) {
      session.dc.send(JSON.stringify({ kind: "file_ack", sid: session.sid, ok: true }));
    }
    endSession(session.sid, null);
  }
}

async function handleSignal(signal) {
  if (!P2P_ENABLED) return;
  if (signal.room !== state.currentRoom) return;
  if (signal.kind === "offer") {
    if (state.pendingOffers.has(signal.sid)) return;
    state.pendingOffers.set(signal.sid, signal);
    showOfferCard(signal);
    return;
  }

  const session = state.sessions.get(signal.sid);
  if (!session) return;

  if (signal.kind === "answer" && session.pc) {
    await session.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
    return;
  }
  if (signal.kind === "ice" && session.pc && signal.candidate) {
    try {
      await session.pc.addIceCandidate(signal.candidate);
    } catch {
      return;
    }
  }
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
relayTest?.addEventListener("click", async () => {
  await connectRelays();
});
relayDefaults?.addEventListener("click", async () => {
  if (relayInput) relayInput.value = DEFAULT_RELAYS.join("\n");
  await saveSettings({ close: false });
});
torCheck?.addEventListener("click", async () => {
  try {
    const ok = await invoke("check_tor", {});
    if (ok) {
      addSystemMessage("Tor proxy is reachable.");
    } else {
      addSystemMessage("Tor is disabled. Enable Use Tor to test.");
    }
  } catch (err) {
    addSystemMessage(`Tor check failed: ${String(err)}`);
  }
});
relayPrune?.addEventListener("click", async () => {
  const bad = new Set(
    state.relayItems.filter((item) => item.state === "error").map((item) => item.url)
  );
  if (!bad.size) {
    setStatus("No failing relays to remove.");
    return;
  }
  const next = state.settings.relays.filter((r) => !bad.has(r));
  if (!next.length) {
    setStatus("All relays would be removed.");
    return;
  }
  relayInput.value = next.join("\n");
  await saveSettings({ close: false });
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

p2pBtn?.addEventListener("click", () => {
  p2pFileInput?.click();
});

p2pFileInput?.addEventListener("change", async (evt) => {
  const file = evt.target.files?.[0];
  if (file) {
    await startP2PSend(file);
  }
  p2pFileInput.value = "";
});

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
    syncPeers([msg]);
  }
  renderRooms();
});

listen("relay-status", (event) => {
  updateRelaySummary(event.payload);
});

listen("signal-message", (event) => {
  handleSignal(event.payload).catch(() => {});
});

loadState().then(connectRelays).catch((err) => setStatus(String(err)));
autoResizeTextarea();
