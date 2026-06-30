/**
 * Pibb Game — client application
 * ==============================
 *
 * A browser-based multiplayer game using PeerJS (WebRTC data channels).
 * No backend server: one player hosts, others connect as guests. The host
 * relays all messages (star topology).
 *
 * SYSTEMS OVERVIEW
 * ----------------
 * 1. Networking   — PeerJS, host/guest roles, message protocol, host migration
 * 2. World        — 2200×2200 map, camera pan/zoom, coordinate transforms
 * 3. Players      — WASD + click-to-move, remote smoothing, name sync
 * 4. Mulch        — Host-spawned pickups, collision, leaderboard scoring
 * 5. Rendering    — Canvas 2D loop, pibble sprites, grid, click ripples
 * 6. Input        — Keyboard, pointer drag-pan, pinch/wheel zoom
 * 7. UI           — Chat sidebar, connection status, editable display name
 *
 * BOOTSTRAP: connect() runs at file bottom on page load (auto-join).
 */

/* ==========================================================================
   CONFIGURATION — tunable constants grouped by subsystem
   ========================================================================== */

/** Fixed PeerJS ID for the lobby host. First client to claim it becomes host. */
const LOBBY_PEER_ID = "SFOONGAME";

/** PeerJS signaling server (public PeerJS cloud). */
const PEERJS_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: [
      "turn:eu-0.turn.peerjs.com:3478",
      "turn:us-0.turn.peerjs.com:3478",
      "turn:eu-0.turn.peerjs.com:3478?transport=tcp",
      "turn:us-0.turn.peerjs.com:3478?transport=tcp",
    ],
    username: "peerjs",
    credential: "peerjsp",
  },
];

/** @param {{ forceRelay?: boolean }} opts */
function getPeerConfig({ forceRelay = false } = {}) {
  const config = {
    iceServers: PEERJS_ICE_SERVERS,
    sdpSemantics: "unified-plan",
    iceCandidatePoolSize: 10,
  };
  if (forceRelay) {
    config.iceTransportPolicy = "relay";
  }
  return {
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
    config,
  };
}

// Connection & session
const JOIN_PEER_OPEN_TIMEOUT_MS = 15000;
const JOIN_HOST_CONN_TIMEOUT_MS = 30000;
const WELCOME_TIMEOUT_MS = 12000;
const GUEST_JOIN_RETRY_MS = 2000;
const GUEST_RELAY_AFTER_ATTEMPTS = 2;
const MAX_GUEST_JOIN_ATTEMPTS = 10;
const MAX_PLAYERS = 8;
const HOST_MIGRATION_DELAY_MS = 500;   // Successor claims host quickly
const GUEST_RECONNECT_DELAY_MS = 2500; // Guests wait for new host to settle
const RECONNECT_RETRY_MS = 3000;

// Movement — hitbox (collision) is smaller than draw size (sprite)
const MOVE_SPEED = 4;
const PLAYER_HITBOX_SIZE = 52;
const PLAYER_DRAW_SIZE = 84;
const PLAYER_HALF = PLAYER_HITBOX_SIZE / 2;
const MOVE_SEND_INTERVAL_MS = 50;      // Throttle network move updates
const MOVEMENT_SMOOTHING = 14;         // Exponential lerp factor for remote players

// Player identity
const MAX_PLAYER_NAME_LENGTH = 24;
const RENAME_DEBOUNCE_MS = 100;

// Mulch pickups (host-authoritative)
const MULCH_SPAWN_INTERVAL_MS = 5000;
const MULCH_RANDOM_MIN_MS = 1000;
const MULCH_RANDOM_MAX_MS = 10000;
const MULCH_SIZE = 14;
const MULCH_COLOR = "#8B5A2B";

// Visual feedback for click-to-move
const CLICK_EFFECT_DURATION_MS = 450;
const CLICK_EFFECT_MAX_RADIUS = 14;

// World bounds and camera
const MAP_WIDTH = 2200;
const MAP_HEIGHT = 2200;
const DRAG_PAN_THRESHOLD = 8;  // Pixels before pointer-down becomes pan drag
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;
const WHEEL_ZOOM_FACTOR = 0.0015;

/* ==========================================================================
   DOM REFERENCES — elements from index.html
   ========================================================================== */

const roleBadge = document.getElementById("role-badge");
const connectionStatus = document.getElementById("connection-status");
const playerCountEl = document.getElementById("player-count");
const playerNameInput = document.getElementById("player-name-input");
const leaderboardList = document.getElementById("leaderboard-list");
const messages = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const leaveBtn = document.getElementById("leave-btn");
const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

/* ==========================================================================
   APPLICATION STATE
   ========================================================================== */

// --- PeerJS / networking ---
let peer = null;              // Local PeerJS instance
let hostConn = null;          // Guest → host data connection
let connections = new Map();  // Host only: peerId → DataConnection
let connToPlayer = new Map(); // Host only: peerId → stable playerId (UUID)
let role = null;              // "host" | "guest"
let joinTimeout = null;
let reconnectTimeout = null;
let guestJoinAttempts = 0;

// --- Player & game world ---
let myPlayerId = null;        // Stable UUID in sessionStorage (survives refresh)
let players = {};             // playerId → { x, y, targetX, targetY, name, mulch, isHost, joinOrder }
let mulchPieces = [];         // { id, x, y } — synced from host
let mulchSpawnInterval = null;
let mulchRandomTimeout = null;
let nextJoinOrder = 1;        // Host assigns join order for migration election

// --- Render loop ---
let animationId = null;
let lastFrameTime = 0;
let lastMoveSent = 0;
let lastSentPos = { x: 0, y: 0 };

// --- Session flags ---
let connectedToHost = false;
let migrating = false;            // Host disconnect in progress
let hasJoinedOnce = false;        // Suppress duplicate welcome messages
let intentionalLeave = false;     // User clicked Leave (don't auto-reconnect)
let sessionEnded = false;
let hostRecentlyMigrated = false; // Tell reconnecting guests to merge state

// Grace period before removing a disconnected player (allows tab refresh)
const pendingRemovals = new Map();
const PLAYER_RECONNECT_GRACE_MS = 2500;

// --- Input state ---
const keys = { w: false, a: false, s: false, d: false };
let moveTarget = null;            // World coords for click-to-move
let clickEffects = [];            // Ripple animations at click points
let camera = { x: 0, y: 0 };      // Top-left of visible world region
let pointerState = null;          // Active single-pointer interaction
let zoom = 1;
const activePointers = new Map(); // All touch/mouse pointers (for pinch)
let pinchState = null;

/* ==========================================================================
   CAMERA & COORDINATE SYSTEM
   World space: 0..MAP_WIDTH × 0..MAP_HEIGHT. Camera is top-left corner.
   Screen space: canvas pixels. Zoom scales world→screen.
   ========================================================================== */

/** Convert browser client coords to canvas pixel coords (handles CSS scaling). */
function getCanvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  };
}

function worldToScreen(x, y) {
  // Subtract camera offset, then scale by zoom
  return {
    x: (x - camera.x) * zoom,
    y: (y - camera.y) * zoom,
  };
}

function screenToWorld(x, y) {
  // Inverse of worldToScreen
  return {
    x: x / zoom + camera.x,
    y: y / zoom + camera.y,
  };
}

function clampCameraPosition(x, y) {
  const viewWidth = canvas.width / zoom;
  const viewHeight = canvas.height / zoom;
  const maxX = Math.max(0, MAP_WIDTH - viewWidth);
  const maxY = Math.max(0, MAP_HEIGHT - viewHeight);
  return {
    x: Math.max(0, Math.min(maxX, x)),
    y: Math.max(0, Math.min(maxY, y)),
  };
}

function centerCameraOn(x, y) {
  const next = clampCameraPosition(
    x - canvas.width / (2 * zoom),
    y - canvas.height / (2 * zoom),
  );
  camera.x = next.x;
  camera.y = next.y;
}

function setZoomAtPoint(nextZoom, screenX, screenY) {
  // Keep the world point under the cursor fixed while zoom changes
  const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  if (Math.abs(clampedZoom - zoom) < 0.0001) return;
  const worldBefore = screenToWorld(screenX, screenY);
  zoom = clampedZoom;
  const nextCamera = clampCameraPosition(
    worldBefore.x - screenX / zoom,
    worldBefore.y - screenY / zoom,
  );
  camera.x = nextCamera.x;
  camera.y = nextCamera.y;
}

/** Keep player center inside world bounds (uses hitbox half-size). */
function clampPlayerPosition(x, y) {
  return {
    x: Math.max(PLAYER_HALF, Math.min(MAP_WIDTH - PLAYER_HALF, x)),
    y: Math.max(PLAYER_HALF, Math.min(MAP_HEIGHT - PLAYER_HALF, y)),
  };
}

/* ==========================================================================
   CLICK EFFECTS — visual ripple when player sets a move target
   ========================================================================== */

function spawnClickEffect(x, y) {
  clickEffects.push({
    x,
    y,
    startTime: performance.now(),
  });
}

function updateClickEffects(now) {
  clickEffects = clickEffects.filter(
    (effect) => now - effect.startTime < CLICK_EFFECT_DURATION_MS,
  );
}

function renderClickEffects(now) {
  const growEnd = 0.22;

  for (const effect of clickEffects) {
    const screen = worldToScreen(effect.x, effect.y);
    if (
      screen.x < -(CLICK_EFFECT_MAX_RADIUS * zoom) ||
      screen.y < -(CLICK_EFFECT_MAX_RADIUS * zoom) ||
      screen.x > canvas.width + CLICK_EFFECT_MAX_RADIUS * zoom ||
      screen.y > canvas.height + CLICK_EFFECT_MAX_RADIUS * zoom
    ) {
      continue;
    }

    const t = Math.min(1, (now - effect.startTime) / CLICK_EFFECT_DURATION_MS);
    let radius;
    let alpha;

    if (t < growEnd) {
      const u = t / growEnd;
      const eased = 1 - Math.pow(1 - u, 3);
      radius = CLICK_EFFECT_MAX_RADIUS * eased;
      alpha = 0.6 * eased;
    } else {
      const u = (t - growEnd) / (1 - growEnd);
      const eased = 1 - Math.pow(1 - u, 2);
      radius = CLICK_EFFECT_MAX_RADIUS * (1 - eased * 0.9);
      alpha = 0.6 * (1 - eased);
    }

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, Math.max(0, radius * zoom), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(59, 130, 246, ${alpha * 0.35})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(232, 237, 244, ${alpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/**
 * After local movement, sync target and throttle move messages to network.
 * Host broadcasts directly; guests send to host for relay.
 */
function syncLocalPosition(p) {
  p.targetX = p.x;
  p.targetY = p.y;

  const now = Date.now();
  if (now - lastMoveSent >= MOVE_SEND_INTERVAL_MS) {
    const dx = Math.abs(p.x - lastSentPos.x);
    const dy = Math.abs(p.y - lastSentPos.y);
    if (dx > 0.5 || dy > 0.5) {
      sendMove(p.x, p.y);
      lastSentPos = { x: p.x, y: p.y };
      lastMoveSent = now;
    }
  }
}

/* ==========================================================================
   SPRITES & AUDIO
   pibble.png is processed at load: near-black pixels become transparent.
   ========================================================================== */

const pibbleSprite = new Image();
let spriteReady = false;
let spriteMask = null;
let spriteSize = { w: PLAYER_DRAW_SIZE, h: PLAYER_DRAW_SIZE };

const SPRITE_BG_THRESHOLD = 45;

pibbleSprite.onload = () => {
  spriteReady = true;
  spriteMask = buildSpriteMask();
  spriteSize = getSpriteDimensions();
};

pibbleSprite.src = "pibble.png";

const munchSound = new Audio("munch-sound-effect.mp3");
munchSound.preload = "auto";

function playMunchSound() {
  const sound = munchSound.cloneNode();
  sound.volume = 0.65;
  sound.play().catch(() => {});
}

function getSpriteDimensions() {
  if (!spriteReady) {
    return { w: PLAYER_DRAW_SIZE, h: PLAYER_DRAW_SIZE };
  }
  const scale = Math.min(
    PLAYER_DRAW_SIZE / pibbleSprite.width,
    PLAYER_DRAW_SIZE / pibbleSprite.height,
  );
  return {
    w: Math.round(pibbleSprite.width * scale),
    h: Math.round(pibbleSprite.height * scale),
  };
}

/** Pre-render sprite with black background pixels made transparent. */
function buildSpriteMask() {
  const { w, h } = getSpriteDimensions();
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d");
  octx.drawImage(pibbleSprite, 0, 0, w, h);

  const imageData = octx.getImageData(0, 0, w, h);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < SPRITE_BG_THRESHOLD && g < SPRITE_BG_THRESHOLD && b < SPRITE_BG_THRESHOLD) {
      data[i + 3] = 0;
    }
  }
  octx.putImageData(imageData, 0, 0);
  return off;
}

/** Draw one player: pibble sprite (or fallback dot) + name label above. */
function drawPlayer(id, p) {
  const { w, h } = spriteSize;
  const drawW = w * zoom;
  const drawH = h * zoom;
  const isLocal = id === myPlayerId;
  let labelOffset = PLAYER_HALF * zoom + 4;
  const screen = worldToScreen(p.x, p.y);

  if (!spriteReady || !spriteMask) {
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, PLAYER_HALF * 0.35 * zoom, 0, Math.PI * 2);
    ctx.fillStyle = "#e8edf4";
    ctx.fill();
  } else {
    ctx.drawImage(spriteMask, screen.x - drawW / 2, screen.y - drawH / 2, drawW, drawH);
    labelOffset = drawH / 2 + 4;
  }

  ctx.fillStyle = isLocal ? "#ffffff" : "#e8edf4";
  const fontSize = Math.max(10, Math.min(16, 11 * Math.sqrt(zoom)));
  ctx.font = isLocal
    ? `bold ${fontSize}px Segoe UI, system-ui, sans-serif`
    : `${fontSize}px Segoe UI, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(isLocal ? `${p.name} (you)` : p.name, screen.x, screen.y - labelOffset);
}

/* ==========================================================================
   PLAYER NAMES — auto-assign, sanitize, persist, and sync over network
   ========================================================================== */

function assignPlayerName() {
  const usedNumbers = new Set();
  for (const p of Object.values(players)) {
    const match = p.name.match(/^Player (\d+)$/);
    if (match) usedNumbers.add(Number(match[1]));
  }
  let n = 1;
  while (usedNumbers.has(n)) n++;
  return `Player ${n}`;
}

function sanitizePlayerName(name) {
  const trimmed = String(name || "").trim().slice(0, MAX_PLAYER_NAME_LENGTH);
  return trimmed || assignPlayerName();
}

function getStoredPlayerName() {
  return sanitizePlayerName(sessionStorage.getItem("playerName") || assignPlayerName());
}

function storePlayerName(name) {
  sessionStorage.setItem("playerName", sanitizePlayerName(name));
}

let syncingNameInput = false;
let renameTimer = null;

function updateNameInput(name) {
  syncingNameInput = true;
  playerNameInput.value = name;
  syncingNameInput = false;
}

function syncLocalNameInput() {
  if (players[myPlayerId]) {
    updateNameInput(players[myPlayerId].name);
  }
}

function applyRename(id, name, fromConn) {
  if (!players[id]) return;

  const trimmed = sanitizePlayerName(name);
  players[id].name = trimmed;

  if (id === myPlayerId) {
    updateNameInput(trimmed);
    storePlayerName(trimmed);
  }

  updateLeaderboard();

  if (role === "host" && fromConn) {
    broadcast({ type: "rename", id, name: trimmed }, fromConn);
  }
}

/** Debounced rename broadcast while user types in the header input. */
function sendRename(name) {
  if (!myPlayerId || !players[myPlayerId]) return;

  const trimmed = sanitizePlayerName(name);
  players[myPlayerId].name = trimmed;
  storePlayerName(trimmed);

  clearTimeout(renameTimer);
  renameTimer = setTimeout(() => {
    const msg = { type: "rename", id: myPlayerId, name: trimmed };
    if (role === "host") {
      broadcast(msg);
    } else if (hostConn?.open) {
      send(hostConn, msg);
    }
  }, RENAME_DEBOUNCE_MS);
}

/* ==========================================================================
   RECONNECT GRACE — delay player removal so tab refresh can reconnect
   ========================================================================== */

function cancelPendingRemoval(playerId) {
  const timeout = pendingRemovals.get(playerId);
  if (timeout) {
    clearTimeout(timeout);
    pendingRemovals.delete(playerId);
  }
}

function schedulePendingRemoval(playerId) {
  cancelPendingRemoval(playerId);
  pendingRemovals.set(
    playerId,
    setTimeout(() => {
      pendingRemovals.delete(playerId);
      const stillConnected = [...connToPlayer.values()].includes(playerId);
      if (!stillConnected && players[playerId]) {
        addSystemMessage(`${players[playerId].name} left.`);
        broadcast({ type: "player-left", id: playerId });
        removePlayer(playerId);
        updateConnectionStatus();
      }
    }, PLAYER_RECONNECT_GRACE_MS),
  );
}

/** Close duplicate connections when same playerId reconnects. */
function detachConnectionsForPlayer(playerId, exceptPeerId) {
  for (const [peerId, mappedId] of [...connToPlayer.entries()]) {
    if (mappedId === playerId && peerId !== exceptPeerId) {
      const conn = connections.get(peerId);
      if (conn) conn.close();
      connections.delete(peerId);
      connToPlayer.delete(peerId);
    }
  }
}

function isPlayerConnected(playerId) {
  return [...connToPlayer.values()].includes(playerId);
}

/** Stable player identity across page reloads (distinct from PeerJS peer ID). */
function getOrCreatePlayerId() {
  let id = sessionStorage.getItem("playerId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("playerId", id);
  }
  return id;
}

/* ==========================================================================
   MESSAGING PRIMITIVES — JSON over PeerJS data channels
   ========================================================================== */

function send(conn, msg) {
  if (!conn) return;
  const data = JSON.stringify(msg);
  if (conn.open) {
    conn.send(data);
  } else {
    conn.once("open", () => {
      if (conn.open) conn.send(data);
    });
  }
}

/** Host relays to all guests except optional excluded connection. */
function broadcast(msg, excludeConn) {
  const data = JSON.stringify(msg);
  for (const conn of connections.values()) {
    if (conn.open && conn !== excludeConn) {
      conn.send(data);
    }
  }
}

/* ==========================================================================
   CANVAS LIFECYCLE
   ========================================================================== */

function getCanvasCenter() {
  return { x: canvas.width / 2, y: canvas.height / 2 };
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  const next = clampCameraPosition(camera.x, camera.y);
  camera.x = next.x;
  camera.y = next.y;
}

function clearJoinTimeout() {
  if (joinTimeout) {
    clearTimeout(joinTimeout);
    joinTimeout = null;
  }
}

function clearReconnectTimeout() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
}

/**
 * Tear down PeerJS, connections, timers, and optionally game state.
 * Used on leave, reconnect, and host migration.
 */
function destroyPeer({ keepPlayers = false, keepMessages = false, preserveIntentionalLeave = false, preserveMigrating = false } = {}) {
  clearJoinTimeout();
  clearReconnectTimeout();
  if (!preserveIntentionalLeave) {
    intentionalLeave = false;
  }

  const wasMigrating = migrating;

  for (const timeout of pendingRemovals.values()) {
    clearTimeout(timeout);
  }
  pendingRemovals.clear();

  stopMulchSpawning();

  if (!keepPlayers) {
    stopGameLoop();
    mulchPieces = [];
  }

  for (const conn of connections.values()) {
    conn.close();
  }
  connections.clear();
  connToPlayer.clear();

  if (hostConn) {
    hostConn.close();
    hostConn = null;
  }

  if (peer) {
    peer.destroy();
    peer = null;
  }

  if (!keepPlayers) {
    players = {};
    nextJoinOrder = 1;
    migrating = false;
    hostRecentlyMigrated = false;
  } else if (preserveMigrating) {
    migrating = wasMigrating;
  }

  connectedToHost = false;
  if (!keepPlayers) {
    keys.w = keys.a = keys.s = keys.d = false;
    moveTarget = null;
    clickEffects = [];
    pointerState = null;
    camera = { x: 0, y: 0 };
  }

  if (!keepMessages) {
    messages.innerHTML = "";
  }
}

/* ==========================================================================
   CONNECTION FLOW — auto-join on load: try host first, else guest
   ========================================================================== */

/** Entry point: load player ID, resize canvas, attempt to claim host role. */
function connect() {
  sessionEnded = false;
  myPlayerId = getOrCreatePlayerId();
  intentionalLeave = false;
  migrating = false;
  guestJoinAttempts = 0;
  resizeCanvas();
  setConnectionState("waiting", "Connecting…");
  disableChat();
  attemptClaimHost();
}

/**
 * Try to become host by opening Peer with fixed LOBBY_PEER_ID.
 * If ID is taken (unavailable-id), fall back to guest join.
 */
function attemptClaimHost() {
  role = "host";
  updateRoleBadge();
  peer = new Peer(LOBBY_PEER_ID, getPeerConfig());

  peer.on("open", () => {
    onBecameHost();
  });

  peer.on("connection", (incoming) => {
    if (connections.size >= MAX_PLAYERS - 1) {
      incoming.send(JSON.stringify({ type: "error", reason: "full" }));
      incoming.close();
      return;
    }
    setupGuestConnection(incoming);
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id") {
      if (peer) {
        peer.destroy();
        peer = null;
      }
      attemptJoinAsGuest();
    } else if (!migrating) {
      scheduleReconnect("Network error — retrying…");
    }
  });
}

/** Host is live: spawn self if needed, start mulch + game loop, enable UI. */
function onBecameHost() {
  const wasMigration = migrating;
  migrating = false;
  connectedToHost = true;
  guestJoinAttempts = 0;
  clearJoinTimeout();

  if (!players[myPlayerId]) {
    spawnPlayer(myPlayerId, getStoredPlayerName());
    players[myPlayerId].joinOrder = 0;
    nextJoinOrder = 1;
  }
  players[myPlayerId].isHost = true;
  centerCameraOn(players[myPlayerId].x, players[myPlayerId].y);

  if (wasMigration) {
    hostRecentlyMigrated = true;
    const orders = Object.values(players).map((p) => p.joinOrder ?? 0);
    nextJoinOrder = Math.max(0, ...orders) + 1;
    setTimeout(() => {
      hostRecentlyMigrated = false;
    }, 30000);
  }

  startMulchSpawning();

  startGameLoop();
  enableChat();
  syncLocalNameInput();
  updateRoleBadge();
  updatePlayerCount();
  updateConnectionStatus();
  updateLeaderboard();

  if (!hasJoinedOnce) {
    addSystemMessage("You are hosting. Others will join automatically.");
    hasJoinedOnce = true;
  } else if (wasMigration) {
    addSystemMessage("You became the new host.");
  }
}

function scheduleJoinTimeout(ms, onTimeout) {
  clearJoinTimeout();
  joinTimeout = setTimeout(() => {
    if (!connectedToHost && !intentionalLeave) {
      onTimeout();
    }
  }, ms);
}

/** Retry guest join (host ID is taken, so a host exists — do not steal host role). */
function retryGuestJoin(message) {
  if (intentionalLeave) return;

  guestJoinAttempts++;
  if (guestJoinAttempts > MAX_GUEST_JOIN_ATTEMPTS) {
    clearJoinTimeout();
    destroyPeer({ keepPlayers: true, keepMessages: true });
    setConnectionState("error", "Could not reach host");
    addSystemMessage(
      "Could not connect after several tries. Ask the host to refresh their tab, then click Leave and rejoin."
    );
    return;
  }

  clearJoinTimeout();
  destroyPeer({ keepPlayers: true, keepMessages: true });
  if (message) addSystemMessage(message);
  setConnectionState("waiting", "Joining game…");
  reconnectTimeout = setTimeout(attemptJoinAsGuest, GUEST_JOIN_RETRY_MS);
}

/** Open anonymous Peer, connect to LOBBY_PEER_ID, send hello with playerId. */
function attemptJoinAsGuest() {
  clearReconnectTimeout();
  role = "guest";
  updateRoleBadge();

  const useRelay = guestJoinAttempts >= GUEST_RELAY_AFTER_ATTEMPTS;
  setConnectionState("waiting", useRelay ? "Connecting via relay…" : "Joining game…");

  peer = new Peer(getPeerConfig({ forceRelay: useRelay }));

  scheduleJoinTimeout(JOIN_PEER_OPEN_TIMEOUT_MS, () => {
    retryGuestJoin("Signaling timed out — retrying…");
  });

  peer.on("open", () => {
    hostConn = peer.connect(LOBBY_PEER_ID, { reliable: true });
    setupHostConnection(hostConn);

    scheduleJoinTimeout(JOIN_HOST_CONN_TIMEOUT_MS, () => {
      retryGuestJoin("Connection timed out — retrying…");
    });
  });

  peer.on("error", () => {
    if (!connectedToHost && !migrating) {
      retryGuestJoin("Network error — retrying…");
    }
  });
}

/** No host exists — become the host ourselves (only used on first page load). */
function onNoHostFound() {
  clearJoinTimeout();
  destroyPeer({ keepPlayers: true, keepMessages: true });
  addSystemMessage("No host found — claiming host…");
  attemptClaimHost();
}

/** Host side: wire incoming guest data connection. */
function setupGuestConnection(connection) {
  connections.set(connection.peer, connection);

  connection.on("data", (data) => {
    handleMessage(data, connection);
  });

  connection.on("close", () => {
    handleGuestDisconnect(connection);
  });

  connection.on("error", () => {
    handleGuestDisconnect(connection);
  });
}

/** Guest side: wire outgoing connection to host; send hello on open. */
function setupHostConnection(connection) {
  connection.on("open", () => {
    setConnectionState("waiting", "Waiting for host…");
    send(connection, {
      type: "hello",
      playerId: myPlayerId,
      name: getStoredPlayerName(),
    });

    scheduleJoinTimeout(WELCOME_TIMEOUT_MS, () => {
      retryGuestJoin("Host did not respond — retrying…");
    });
  });

  connection.on("data", (data) => {
    handleMessage(data, connection);
  });

  connection.on("close", () => {
    if (intentionalLeave) return;
    if (!connectedToHost) {
      retryGuestJoin("Connection closed — retrying…");
      return;
    }
    handleHostDisconnect();
  });

  connection.on("error", () => {
    if (!connectedToHost && !intentionalLeave) {
      retryGuestJoin("Connection failed — retrying…");
    }
  });
}

/* ==========================================================================
   MESSAGE PROTOCOL — central dispatcher for all network message types
   Types: hello, welcome, move, chat, rename, player-joined, player-left,
          leave, mulch-spawn, mulch-collect, error
   ========================================================================== */

function handleMessage(data, fromConn) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    addChatMessage(String(data), false);
    return;
  }

  switch (msg.type) {
    // Guest → Host: initial handshake with stable playerId + display name
    case "hello":
      if (role !== "host" || !fromConn) break;
      handleGuestHello(fromConn, msg.playerId, msg.name);
      break;

    // Host → Guest: full state snapshot after hello
    case "welcome":
      if (role !== "guest") break;
      applyWelcome(msg);
      break;

    case "error":
      if (msg.reason === "full") {
        addSystemMessage("Game is full.");
        intentionalLeave = true;
        scheduleReconnect("Room full — retrying later…", 5000);
      }
      break;

    // Host relays chat to all guests; guests display incoming directly
    case "chat":
      if (role === "host" && fromConn) {
        addChatMessage(msg.text, false, msg.from);
        broadcast(msg, fromConn);
      } else {
        addChatMessage(msg.text, false, msg.from);
      }
      break;

    // Position sync: host applies + relays; also checks mulch on each move (tab-focus fix)
    case "move":
      if (role === "host") {
        applyMove(msg.id, msg.x, msg.y);
        checkMulchCollisionsForPlayer(msg.id);
        broadcast({ type: "move", id: msg.id, x: msg.x, y: msg.y }, fromConn);
      } else if (players[msg.id]) {
        setPlayerTarget(players[msg.id], msg.x, msg.y);
      }
      break;

    // New player entered (broadcast by host after hello)
    case "player-joined":
      players[msg.id] = { ...msg.player };
      if (players[msg.id].targetX === undefined) {
        players[msg.id].targetX = msg.player.x;
        players[msg.id].targetY = msg.player.y;
      }
      addSystemMessage(`${msg.player.name} joined.`);
      updatePlayerCount();
      updateLeaderboard();
      break;

    // Player removed after disconnect grace period or explicit leave
    case "player-left":
      if (players[msg.id]) {
        addSystemMessage(`${players[msg.id].name} left.`);
        removePlayer(msg.id);
      }
      break;

    // Display name change — host relays to other guests
    case "rename":
      if (role === "host" && fromConn) {
        applyRename(msg.id, msg.name, fromConn);
      } else {
        applyRename(msg.id, msg.name);
      }
      break;

    // Host spawns mulch; all clients add piece to local array
    case "mulch-spawn":
      if (!mulchPieces.some((m) => m.id === msg.piece.id)) {
        mulchPieces.push({ ...msg.piece });
      }
      break;

    // Host collected mulch; remove piece, update score, play sound
    case "mulch-collect":
      mulchPieces = mulchPieces.filter((m) => m.id !== msg.mulchId);
      if (players[msg.playerId]) {
        players[msg.playerId].mulch = msg.mulch;
      }
      playMunchSound();
      updateLeaderboard();
      break;

    // Explicit leave (tab close or Leave button) — immediate removal on host
    case "leave":
      if (role === "host" && fromConn) {
        const playerId = msg.playerId || connToPlayer.get(fromConn.peer);
        removeConnectedPlayer(playerId, fromConn, { immediate: true });
      } else if (role === "guest" && msg.playerId && players[msg.playerId]) {
        addSystemMessage(`${players[msg.playerId].name} left.`);
        removePlayer(msg.playerId);
      }
      break;
  }
}

/**
 * Host handles new guest connection: spawn or reconnect player,
 * send welcome snapshot (players + mulch), broadcast player-joined.
 */
function handleGuestHello(connection, playerId, preferredName) {
  cancelPendingRemoval(playerId);

  const isReconnect = !!players[playerId];

  if (!isReconnect) {
    if (Object.keys(players).length >= MAX_PLAYERS) {
      send(connection, { type: "error", reason: "full" });
      connection.close();
      return;
    }
    spawnPlayer(playerId, sanitizePlayerName(preferredName));
    players[playerId].joinOrder = nextJoinOrder++;
  } else {
    detachConnectionsForPlayer(playerId, connection.peer);
  }

  connToPlayer.set(connection.peer, playerId);
  send(connection, {
    type: "welcome",
    playerId,
    players: getPlayersSnapshot(),
    mulch: getMulchSnapshot(),
    migrating: hostRecentlyMigrated && isReconnect,
  });

  if (!isReconnect) {
    broadcast({ type: "player-joined", id: playerId, player: players[playerId] }, connection);
    addSystemMessage(`${players[playerId].name} joined.`);
  }

  updatePlayerCount();
  updateConnectionStatus();
  updateLeaderboard();
}

/* ==========================================================================
   PLAYER STATE SYNC — snapshots, welcome, merge on host migration
   ========================================================================== */

function getMulchSnapshot() {
  return mulchPieces.map((m) => ({ id: m.id, x: m.x, y: m.y }));
}

function applyMulchSnapshot(mulch) {
  if (!Array.isArray(mulch)) return;
  mulchPieces = mulch.map((m) => ({ id: m.id, x: m.x, y: m.y }));
}

function copyPlayerFromSnapshot(p) {
  const x = p.x ?? 0;
  const y = p.y ?? 0;
  return {
    x,
    y,
    targetX: p.targetX ?? x,
    targetY: p.targetY ?? y,
    name: p.name,
    mulch: p.mulch ?? 0,
    isHost: !!p.isHost,
    joinOrder: p.joinOrder,
  };
}

/** Merge incoming snapshot into local state (preserves positions on migration). */
function mergePlayerState(incoming) {
  for (const [id, incomingPlayer] of Object.entries(incoming)) {
    const x = incomingPlayer.x ?? 0;
    const y = incomingPlayer.y ?? 0;

    if (!players[id]) {
      players[id] = copyPlayerFromSnapshot(incomingPlayer);
      continue;
    }

    const local = players[id];
    local.name = incomingPlayer.name;
    local.mulch = incomingPlayer.mulch ?? local.mulch ?? 0;
    local.isHost = !!incomingPlayer.isHost;
    local.joinOrder = incomingPlayer.joinOrder;

    if (id === myPlayerId) {
      updateNameInput(local.name);
      continue;
    }

    setPlayerPosition(local, x, y);
  }
}

/** Guest receives full game state from host after hello. */
function applyWelcome(msg) {
  connectedToHost = true;
  migrating = false;
  guestJoinAttempts = 0;
  clearJoinTimeout();
  clearReconnectTimeout();

  if (msg.migrating || migrating) {
    mergePlayerState(msg.players);
  } else {
    players = {};
    for (const [id, p] of Object.entries(msg.players)) {
      players[id] = copyPlayerFromSnapshot(p);
    }
  }

  if (!players[myPlayerId]) {
    const center = getCanvasCenter();
    players[myPlayerId] = {
      x: center.x,
      y: center.y,
      targetX: center.x,
      targetY: center.y,
      name: getStoredPlayerName(),
      mulch: 0,
      joinOrder: nextJoinOrder++,
    };
  }
  centerCameraOn(players[myPlayerId].x, players[myPlayerId].y);

  if (msg.mulch) {
    applyMulchSnapshot(msg.mulch);
  }

  syncLocalNameInput();

  startGameLoop();
  enableChat();
  updateRoleBadge();
  setConnectionState("connected", "Connected");
  updatePlayerCount();
  updateLeaderboard();

  if (!hasJoinedOnce) {
    addSystemMessage("Use WASD to move.");
    hasJoinedOnce = true;
  }
}

function setPlayerPosition(p, x, y) {
  p.x = x;
  p.y = y;
  p.targetX = x;
  p.targetY = y;
}

function setPlayerTarget(p, x, y) {
  p.targetX = x;
  p.targetY = y;
}
function spawnPlayer(id, name) {
  const center = getCanvasCenter();
  players[id] = {
    x: center.x,
    y: center.y,
    targetX: center.x,
    targetY: center.y,
    name: sanitizePlayerName(name),
    mulch: 0,
  };
}

function removePlayer(id) {
  delete players[id];
  updatePlayerCount();
  updateLeaderboard();
}

function applyMove(id, x, y) {
  if (!players[id]) return;
  if (id === myPlayerId) {
    setPlayerPosition(players[id], x, y);
  } else {
    setPlayerTarget(players[id], x, y);
  }
}

/** Serializable player state for welcome / migration (uses target position). */
function getPlayersSnapshot() {
  const snapshot = {};
  for (const [id, p] of Object.entries(players)) {
    snapshot[id] = {
      x: p.targetX ?? p.x,
      y: p.targetY ?? p.y,
      name: p.name,
      mulch: p.mulch ?? 0,
      isHost: !!p.isHost,
      joinOrder: p.joinOrder,
    };
  }
  return snapshot;
}

/** Lowest joinOrder wins host election when current host disconnects. */
function findSuccessor() {
  let successor = myPlayerId;
  let bestOrder = players[myPlayerId]?.joinOrder ?? Infinity;

  for (const [id, p] of Object.entries(players)) {
    if (p.joinOrder < bestOrder) {
      bestOrder = p.joinOrder;
      successor = id;
    }
  }

  return successor;
}

function removeHostPlayer() {
  const hostId = Object.entries(players).find(([, p]) => p.isHost)?.[0];
  if (hostId && hostId !== myPlayerId) {
    removePlayer(hostId);
  } else if (hostId === myPlayerId) {
    delete players[hostId].isHost;
  }
}

/* ==========================================================================
   DISCONNECT & LEAVE — graceful teardown and host migration
   ========================================================================== */

function removeConnectedPlayer(playerId, connection, { immediate = false } = {}) {
  if (connection) {
    connections.delete(connection.peer);
    connToPlayer.delete(connection.peer);
  }

  if (!playerId || !players[playerId]) {
    updateConnectionStatus();
    return;
  }

  if (immediate) {
    cancelPendingRemoval(playerId);
    addSystemMessage(`${players[playerId].name} left.`);
    broadcast({ type: "player-left", id: playerId });
    removePlayer(playerId);
    updateConnectionStatus();
    return;
  }

  if (!isPlayerConnected(playerId)) {
    schedulePendingRemoval(playerId);
  }

  updateConnectionStatus();
}

function handleGuestDisconnect(connection) {
  removeConnectedPlayer(connToPlayer.get(connection.peer), connection);
}

/** Best-effort leave message on tab close (pagehide). */
function notifyLeave() {
  if (!myPlayerId) return;
  const msg = { type: "leave", playerId: myPlayerId };
  try {
    if (role === "host") {
      broadcast(msg);
    } else if (hostConn?.open) {
      send(hostConn, msg);
    }
  } catch (_) {
    // Best-effort during tab close
  }
}

/**
 * Leave session: notify peers, destroy connections.
 * reconnect=true (Leave button) clears hasJoinedOnce and re-connects.
 */
function leaveSession({ reconnect = false } = {}) {
  if (sessionEnded) return;

  intentionalLeave = true;

  if (!reconnect) {
    notifyLeave();
    sessionStorage.removeItem("playerId");
    sessionStorage.removeItem("playerName");
  }

  destroyPeer({ preserveIntentionalLeave: true });

  if (reconnect) {
    hasJoinedOnce = false;
    connect();
  } else {
    sessionEnded = true;
  }
}

/**
 * Guest path when host drops: elect successor, staggered reconnect delays.
 * Successor becomes new host; others rejoin as guests.
 */
function handleHostDisconnect() {
  if (role !== "guest" || migrating || intentionalLeave) return;

  migrating = true;
  connectedToHost = false;
  hostConn = null;
  disableChat();
  setConnectionState("waiting", "Host disconnected — migrating…");
  addSystemMessage("Host left. Electing a new host…");

  removeHostPlayer();

  const successor = findSuccessor();
  const delay = myPlayerId === successor ? HOST_MIGRATION_DELAY_MS : GUEST_RECONNECT_DELAY_MS;

  clearReconnectTimeout();
  reconnectTimeout = setTimeout(() => {
    if (myPlayerId === successor) {
      attemptHostMigration();
    } else {
      attemptReconnectAsGuest();
    }
  }, delay);
}

/** Elected guest preserves state, destroys peer, re-claims LOBBY_PEER_ID. */
function attemptHostMigration() {
  const preservedPlayers = getPlayersSnapshot();
  const preservedMulch = getMulchSnapshot();
  destroyPeer({ keepPlayers: true, keepMessages: true, preserveMigrating: true });
  migrating = true;
  setConnectionState("waiting", "Becoming host…");

  players = {};
  for (const [id, p] of Object.entries(preservedPlayers)) {
    players[id] = copyPlayerFromSnapshot(p);
  }
  applyMulchSnapshot(preservedMulch);

  removeHostPlayer();
  if (players[myPlayerId]) {
    players[myPlayerId].isHost = true;
  }

  attemptClaimHost();
}

function attemptReconnectAsGuest() {
  destroyPeer({ keepPlayers: true, keepMessages: true });
  migrating = true;
  setConnectionState("waiting", "Reconnecting…");
  attemptJoinAsGuest();
}

function scheduleReconnect(message, delay = RECONNECT_RETRY_MS) {
  destroyPeer({ keepPlayers: true, keepMessages: true });
  setConnectionState("waiting", message);
  clearReconnectTimeout();
  reconnectTimeout = setTimeout(connect, delay);
}

/* ==========================================================================
   UI UPDATES — connection badge, chat enable, leaderboard DOM
   ========================================================================== */

function updateConnectionStatus() {
  if (role !== "host") return;
  const count = Object.keys(players).length;
  if (count <= 1) {
    setConnectionState("connected", "Hosting — waiting for players");
  } else {
    setConnectionState("connected", `Hosting — ${count} players`);
  }
}

function updateRoleBadge() {
  roleBadge.textContent = role === "host" ? "Host" : "Guest";
  roleBadge.classList.toggle("guest", role === "guest");
}

function enableChat() {
  messageInput.disabled = false;
  messageForm.querySelector("button").disabled = false;
  playerNameInput.disabled = false;
}

function disableChat() {
  messageInput.disabled = true;
  messageForm.querySelector("button").disabled = true;
  playerNameInput.disabled = true;
}

function setConnectionState(state, text) {
  connectionStatus.className = `connection ${state}`;
  connectionStatus.textContent = text;
}

function updatePlayerCount() {
  const count = Object.keys(players).length;
  playerCountEl.textContent = count === 1 ? "1 player" : `${count} players`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function updateLeaderboard() {
  const sorted = Object.entries(players)
    .map(([id, p]) => ({ id, name: p.name, mulch: p.mulch ?? 0 }))
    .sort((a, b) => b.mulch - a.mulch || a.name.localeCompare(b.name));

  if (sorted.length === 0) {
    leaderboardList.innerHTML = `<li class="leaderboard-empty">No players yet</li>`;
    return;
  }

  leaderboardList.innerHTML = sorted
    .map((entry, index) => {
      const localClass = entry.id === myPlayerId ? " is-local" : "";
      return `<li class="${localClass.trim()}">
        <span class="rank">${index + 1}</span>
        <span class="name">${escapeHtml(entry.name)}</span>
        <span class="score">${entry.mulch}</span>
      </li>`;
    })
    .join("");
}

/* ==========================================================================
   MULCH SYSTEM — host spawns, detects collisions, broadcasts collection
   Guests also check collisions on move messages (background-tab fix).
   ========================================================================== */

function startMulchSpawning() {
  if (role !== "host") return;

  if (!mulchSpawnInterval) {
    mulchSpawnInterval = setInterval(() => {
      if (role === "host" && canvas.width > 0 && canvas.height > 0) {
        spawnMulch();
      }
    }, MULCH_SPAWN_INTERVAL_MS);
  }

  scheduleRandomMulchSpawn();
}

function stopMulchSpawning() {
  if (mulchSpawnInterval) {
    clearInterval(mulchSpawnInterval);
    mulchSpawnInterval = null;
  }
  clearRandomMulchSpawn();
}

function scheduleRandomMulchSpawn() {
  clearRandomMulchSpawn();
  if (role !== "host") return;

  const delay =
    MULCH_RANDOM_MIN_MS +
    Math.random() * (MULCH_RANDOM_MAX_MS - MULCH_RANDOM_MIN_MS);

  mulchRandomTimeout = setTimeout(() => {
    mulchRandomTimeout = null;
    if (role === "host" && canvas.width > 0 && canvas.height > 0) {
      spawnMulch();
    }
    scheduleRandomMulchSpawn();
  }, delay);
}

function clearRandomMulchSpawn() {
  if (mulchRandomTimeout) {
    clearTimeout(mulchRandomTimeout);
    mulchRandomTimeout = null;
  }
}

/** Host-only: spawn at random world position and broadcast mulch-spawn. */
function spawnMulch() {
  const padding = MULCH_SIZE / 2 + PLAYER_HALF;
  const maxX = MAP_WIDTH - padding;
  const maxY = MAP_HEIGHT - padding;
  if (maxX <= padding || maxY <= padding) return;

  const piece = {
    id: crypto.randomUUID(),
    x: padding + Math.random() * (maxX - padding),
    y: padding + Math.random() * (maxY - padding),
  };

  mulchPieces.push(piece);
  broadcast({ type: "mulch-spawn", piece });
  // Handle cases where mulch spawns directly under a player.
  checkMulchCollisions();
}

function getPlayerPosition(p) {
  return { x: p.targetX ?? p.x, y: p.targetY ?? p.y };
}

function checkMulchCollisions() {
  if (role !== "host") return;

  for (let i = mulchPieces.length - 1; i >= 0; i--) {
    const piece = mulchPieces[i];
    for (const [playerId, player] of Object.entries(players)) {
      const pos = getPlayerPosition(player);
      const dist = Math.hypot(pos.x - piece.x, pos.y - piece.y);
      if (dist < PLAYER_HALF + MULCH_SIZE / 2) {
        collectMulch(playerId, piece.id);
        break;
      }
    }
  }
}

function checkMulchCollisionsForPlayer(playerId) {
  if (role !== "host") return;
  const player = players[playerId];
  if (!player) return;

  const pos = getPlayerPosition(player);
  for (let i = mulchPieces.length - 1; i >= 0; i--) {
    const piece = mulchPieces[i];
    const dist = Math.hypot(pos.x - piece.x, pos.y - piece.y);
    if (dist < PLAYER_HALF + MULCH_SIZE / 2) {
      collectMulch(playerId, piece.id);
    }
  }
}

/** Authoritative collection on host; guests learn via mulch-collect message. */
function collectMulch(playerId, mulchId) {
  const pieceIndex = mulchPieces.findIndex((m) => m.id === mulchId);
  if (pieceIndex === -1 || !players[playerId]) return;

  mulchPieces.splice(pieceIndex, 1);
  players[playerId].mulch = (players[playerId].mulch ?? 0) + 1;
  playMunchSound();

  broadcast({
    type: "mulch-collect",
    playerId,
    mulchId,
    mulch: players[playerId].mulch,
  });

  updateLeaderboard();
}

/* ==========================================================================
   CHAT UI — system messages and player chat bubbles
   ========================================================================== */

function addSystemMessage(text) {
  const el = document.createElement("div");
  el.className = "message system";
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function addChatMessage(text, isLocal, fromName) {
  const el = document.createElement("div");
  el.className = `message ${isLocal ? "local" : "remote"}`;
  if (!isLocal && fromName) {
    el.textContent = `${fromName}: ${text}`;
  } else {
    el.textContent = text;
  }
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

/* ==========================================================================
   GAME LOOP — requestAnimationFrame: update → collide → render
   ========================================================================== */

function startGameLoop() {
  if (animationId) return;
  lastFrameTime = performance.now();
  function loop(now) {
    const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
    lastFrameTime = now;
    updateLocalPlayer();
    updateRemotePlayers(dt);
    updateClickEffects(now);
    if (role === "host") {
      checkMulchCollisions();
    }
    render(now);
    animationId = requestAnimationFrame(loop);
  }
  animationId = requestAnimationFrame(loop);
}

/** Exponential smoothing: remote players lerp toward last known target. */
function updateRemotePlayers(dt) {
  const t = 1 - Math.exp(-MOVEMENT_SMOOTHING * dt);
  for (const [id, p] of Object.entries(players)) {
    if (id === myPlayerId || p.targetX === undefined) continue;
    p.x += (p.targetX - p.x) * t;
    p.y += (p.targetY - p.y) * t;
  }
}

function stopGameLoop() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/** WASD takes priority over click target; clamp to map and send moves. */
function updateLocalPlayer() {
  if (!myPlayerId || !players[myPlayerId]) return;

  const p = players[myPlayerId];
  let moved = false;
  const usingKeys = keys.w || keys.a || keys.s || keys.d;

  if (usingKeys) {
    moveTarget = null;
    if (keys.w) { p.y -= MOVE_SPEED; moved = true; }
    if (keys.s) { p.y += MOVE_SPEED; moved = true; }
    if (keys.a) { p.x -= MOVE_SPEED; moved = true; }
    if (keys.d) { p.x += MOVE_SPEED; moved = true; }
  } else if (moveTarget) {
    const dx = moveTarget.x - p.x;
    const dy = moveTarget.y - p.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= MOVE_SPEED) {
      p.x = moveTarget.x;
      p.y = moveTarget.y;
      moveTarget = null;
      moved = true;
    } else {
      p.x += (dx / dist) * MOVE_SPEED;
      p.y += (dy / dist) * MOVE_SPEED;
      moved = true;
    }
  }

  if (moved) {
    const clamped = clampPlayerPosition(p.x, p.y);
    p.x = clamped.x;
    p.y = clamped.y;
    syncLocalPosition(p);
    if (role === "host") {
      checkMulchCollisionsForPlayer(myPlayerId);
    }
  }
}

function sendMove(x, y) {
  const msg = { type: "move", id: myPlayerId, x, y };
  if (role === "host") {
    broadcast(msg);
  } else if (hostConn && hostConn.open) {
    send(hostConn, msg);
  }
}

/** Single frame: grid background, mulch squares, players, click effects. */
function render(now = performance.now()) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#2d3f56";
  ctx.lineWidth = 1;
  const gridSize = 40;
  const screenGrid = gridSize * zoom;
  const startX = -((camera.x * zoom) % screenGrid + screenGrid) % screenGrid;
  const startY = -((camera.y * zoom) % screenGrid + screenGrid) % screenGrid;
  for (let x = startX; x < canvas.width; x += screenGrid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = startY; y < canvas.height; y += screenGrid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  renderClickEffects(now);

  for (const piece of mulchPieces) {
    const screen = worldToScreen(piece.x, piece.y);
    const drawSize = MULCH_SIZE * zoom;
    if (
      screen.x < -drawSize ||
      screen.y < -drawSize ||
      screen.x > canvas.width + drawSize ||
      screen.y > canvas.height + drawSize
    ) {
      continue;
    }
    ctx.fillStyle = MULCH_COLOR;
    ctx.fillRect(
      screen.x - drawSize / 2,
      screen.y - drawSize / 2,
      drawSize,
      drawSize,
    );
  }

  for (const [id, p] of Object.entries(players)) {
    drawPlayer(id, p);
  }
}

/** Prevent WASD while typing in chat or name field. */
function isChatFocused() {
  return document.activeElement === messageInput || document.activeElement === playerNameInput;
}

function clearMovementKeys() {
  keys.w = keys.a = keys.s = keys.d = false;
  moveTarget = null;
}

/* ==========================================================================
   INPUT HANDLERS — pointer (pan/click/pinch), wheel zoom, keyboard WASD
   ========================================================================== */

canvas.addEventListener("pointerdown", (e) => {
  if (!myPlayerId || isChatFocused()) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;

  const point = getCanvasPoint(e.clientX, e.clientY);
  activePointers.set(e.pointerId, point);
  if (activePointers.size >= 2) {
    const pts = Array.from(activePointers.values());
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    pinchState = {
      startDistance: Math.max(1, Math.hypot(dx, dy)),
      startZoom: zoom,
    };
    pointerState = null;
    moveTarget = null;
    canvas.setPointerCapture(e.pointerId);
    return;
  }

  pointerState = {
    pointerId: e.pointerId,
    startX: point.x,
    startY: point.y,
    startCameraX: camera.x,
    startCameraY: camera.y,
    dragging: false,
  };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  const point = getCanvasPoint(e.clientX, e.clientY);
  if (activePointers.has(e.pointerId)) {
    activePointers.set(e.pointerId, point);
  }

  if (pinchState && activePointers.size >= 2) {
    const pts = Array.from(activePointers.values());
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const midpointX = (pts[0].x + pts[1].x) / 2;
    const midpointY = (pts[0].y + pts[1].y) / 2;
    const targetZoom = pinchState.startZoom * (distance / pinchState.startDistance);
    setZoomAtPoint(targetZoom, midpointX, midpointY);
    return;
  }

  if (!pointerState || pointerState.pointerId !== e.pointerId) return;
  const dx = point.x - pointerState.startX;
  const dy = point.y - pointerState.startY;

  if (!pointerState.dragging && Math.hypot(dx, dy) >= DRAG_PAN_THRESHOLD) {
    pointerState.dragging = true;
    moveTarget = null;
  }
  if (!pointerState.dragging) return;

  const next = clampCameraPosition(
    pointerState.startCameraX - dx,
    pointerState.startCameraY - dy,
  );
  camera.x = next.x;
  camera.y = next.y;
});

/** Pointer up: if not a drag, treat as click-to-move with ripple effect. */
function finishPointerInteraction(e) {
  activePointers.delete(e.pointerId);
  if (pinchState && activePointers.size < 2) {
    pinchState = null;
  }
  if (!pointerState || pointerState.pointerId !== e.pointerId) {
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    return;
  }
  const point = getCanvasPoint(e.clientX, e.clientY);
  if (!pointerState.dragging && myPlayerId && !isChatFocused()) {
    const world = screenToWorld(point.x, point.y);
    const clamped = clampPlayerPosition(world.x, world.y);
    moveTarget = clamped;
    spawnClickEffect(clamped.x, clamped.y);
  }
  pointerState = null;
  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
}

canvas.addEventListener("pointerup", finishPointerInteraction);
canvas.addEventListener("pointercancel", finishPointerInteraction);
canvas.addEventListener("wheel", (e) => {
  if (isChatFocused()) return;
  e.preventDefault();
  const point = getCanvasPoint(e.clientX, e.clientY);
  const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR);
  setZoomAtPoint(zoom * factor, point.x, point.y);
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (!myPlayerId || isChatFocused()) return;
  const key = e.key.toLowerCase();
  if (key in keys) {
    keys[key] = true;
    e.preventDefault();
  }
});

window.addEventListener("keyup", (e) => {
  if (isChatFocused()) return;
  const key = e.key.toLowerCase();
  if (key in keys) {
    keys[key] = false;
    e.preventDefault();
  }
});

messageInput.addEventListener("focus", clearMovementKeys);
messageInput.addEventListener("blur", clearMovementKeys);
playerNameInput.addEventListener("focus", clearMovementKeys);
playerNameInput.addEventListener("blur", clearMovementKeys);

playerNameInput.addEventListener("input", () => {
  if (syncingNameInput || !myPlayerId) return;
  sendRename(playerNameInput.value);
});

window.addEventListener("resize", resizeCanvas);

messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  const fromName = players[myPlayerId]?.name || "Player";
  const msg = { type: "chat", text, from: fromName };

  if (role === "host") {
    broadcast(msg);
  } else if (hostConn && hostConn.open) {
    send(hostConn, msg);
  } else {
    return;
  }

  addChatMessage(text, true);
  messageInput.value = "";
});

/* ==========================================================================
   BOOTSTRAP — auto-connect on page load; pagehide triggers clean leave
   ========================================================================== */

leaveBtn.addEventListener("click", () => {
  leaveSession({ reconnect: true });
});

window.addEventListener("pagehide", () => {
  leaveSession();
});

connect();
