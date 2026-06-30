const LOBBY_PEER_ID = "SFOONGAME";

const PEER_CONFIG = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
};

const JOIN_TIMEOUT_MS = 12000;
const MAX_PLAYERS = 8;
const MOVE_SPEED = 4;
const PLAYER_SPRITE_SIZE = 52;
const PLAYER_HALF = PLAYER_SPRITE_SIZE / 2;
const MOVE_SEND_INTERVAL_MS = 50;
const MOVEMENT_SMOOTHING = 14;
const HOST_MIGRATION_DELAY_MS = 500;
const GUEST_RECONNECT_DELAY_MS = 2500;
const RECONNECT_RETRY_MS = 3000;
const MAX_PLAYER_NAME_LENGTH = 24;
const RENAME_DEBOUNCE_MS = 100;
const MULCH_SPAWN_INTERVAL_MS = 5000;
const MULCH_SIZE = 14;
const MULCH_COLOR = "#8B5A2B";

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

let peer = null;
let hostConn = null;
let connections = new Map();
let connToPlayer = new Map();
let role = null;
let joinTimeout = null;
let reconnectTimeout = null;
let myPlayerId = null;
let players = {};
let mulchPieces = [];
let mulchSpawnInterval = null;
let nextJoinOrder = 1;
let animationId = null;
let lastFrameTime = 0;
let lastMoveSent = 0;
let lastSentPos = { x: 0, y: 0 };
let connectedToHost = false;
let migrating = false;
let hasJoinedOnce = false;
let intentionalLeave = false;
let sessionEnded = false;
let hostRecentlyMigrated = false;
const pendingRemovals = new Map();
const PLAYER_RECONNECT_GRACE_MS = 2500;

const keys = { w: false, a: false, s: false, d: false };

const pibbleSprite = new Image();
let spriteReady = false;
let spriteMask = null;
let spriteSize = { w: PLAYER_SPRITE_SIZE, h: PLAYER_SPRITE_SIZE };

const SPRITE_BG_THRESHOLD = 45;

pibbleSprite.onload = () => {
  spriteReady = true;
  spriteMask = buildSpriteMask();
  spriteSize = getSpriteDimensions();
};

pibbleSprite.src = "pibble.png";

function getSpriteDimensions() {
  if (!spriteReady) {
    return { w: PLAYER_SPRITE_SIZE, h: PLAYER_SPRITE_SIZE };
  }
  const scale = Math.min(
    PLAYER_SPRITE_SIZE / pibbleSprite.width,
    PLAYER_SPRITE_SIZE / pibbleSprite.height,
  );
  return {
    w: Math.round(pibbleSprite.width * scale),
    h: Math.round(pibbleSprite.height * scale),
  };
}

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

function drawPlayer(id, p) {
  const { w, h } = spriteSize;
  let labelOffset = PLAYER_HALF + 4;

  if (!spriteReady || !spriteMask) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_HALF * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = "#e8edf4";
    ctx.fill();
  } else {
    const dx = p.x - w / 2;
    const dy = p.y - h / 2;

    if (id === myPlayerId) {
      ctx.save();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(dx - 2, dy - 2, w + 4, h + 4);
      ctx.restore();
    }

    ctx.drawImage(spriteMask, dx, dy);
    labelOffset = h / 2 + 4;
  }

  ctx.fillStyle = "#e8edf4";
  ctx.font = "11px Segoe UI, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(p.name, p.x, p.y - labelOffset);
}

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

function getOrCreatePlayerId() {
  let id = sessionStorage.getItem("playerId");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("playerId", id);
  }
  return id;
}

function send(conn, msg) {
  if (conn && conn.open) {
    conn.send(JSON.stringify(msg));
  }
}

function broadcast(msg, excludeConn) {
  const data = JSON.stringify(msg);
  for (const conn of connections.values()) {
    if (conn.open && conn !== excludeConn) {
      conn.send(data);
    }
  }
}

function getCanvasCenter() {
  return { x: canvas.width / 2, y: canvas.height / 2 };
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
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
  }

  if (!keepMessages) {
    messages.innerHTML = "";
  }
}

function connect() {
  sessionEnded = false;
  myPlayerId = getOrCreatePlayerId();
  intentionalLeave = false;
  migrating = false;
  resizeCanvas();
  setConnectionState("waiting", "Connecting…");
  disableChat();
  attemptClaimHost();
}

function attemptClaimHost() {
  role = "host";
  updateRoleBadge();
  peer = new Peer(LOBBY_PEER_ID, PEER_CONFIG);

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

function onBecameHost() {
  const wasMigration = migrating;
  migrating = false;
  connectedToHost = true;

  if (!players[myPlayerId]) {
    spawnPlayer(myPlayerId, getStoredPlayerName());
    players[myPlayerId].joinOrder = 0;
    nextJoinOrder = 1;
  }
  players[myPlayerId].isHost = true;

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

function attemptJoinAsGuest() {
  role = "guest";
  updateRoleBadge();
  setConnectionState("waiting", "Joining game…");

  peer = new Peer(PEER_CONFIG);

  peer.on("open", () => {
    hostConn = peer.connect(LOBBY_PEER_ID, { reliable: true });
    setupHostConnection(hostConn);

    joinTimeout = setTimeout(() => {
      if (!connectedToHost && !migrating) {
        onNoHostFound();
      }
    }, JOIN_TIMEOUT_MS);
  });

  peer.on("error", () => {
    if (!connectedToHost && !migrating) {
      scheduleReconnect("Connection failed — retrying…");
    }
  });
}

function onNoHostFound() {
  clearJoinTimeout();
  destroyPeer({ keepPlayers: true, keepMessages: true });
  addSystemMessage("No host found — claiming host…");
  attemptClaimHost();
}

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

function setupHostConnection(connection) {
  connection.on("open", () => {
    clearJoinTimeout();
    send(connection, {
      type: "hello",
      playerId: myPlayerId,
      name: getStoredPlayerName(),
    });
  });

  connection.on("data", (data) => {
    handleMessage(data, connection);
  });

  connection.on("close", () => {
    if (!intentionalLeave) {
      handleHostDisconnect();
    }
  });

  connection.on("error", () => {
    if (!connectedToHost && !intentionalLeave) {
      clearJoinTimeout();
      onNoHostFound();
    }
  });
}

function handleMessage(data, fromConn) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    addChatMessage(String(data), false);
    return;
  }

  switch (msg.type) {
    case "hello":
      if (role !== "host" || !fromConn) break;
      handleGuestHello(fromConn, msg.playerId, msg.name);
      break;

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

    case "chat":
      if (role === "host" && fromConn) {
        addChatMessage(msg.text, false, msg.from);
        broadcast(msg, fromConn);
      } else {
        addChatMessage(msg.text, false, msg.from);
      }
      break;

    case "move":
      if (role === "host") {
        applyMove(msg.id, msg.x, msg.y);
        broadcast({ type: "move", id: msg.id, x: msg.x, y: msg.y }, fromConn);
      } else if (players[msg.id]) {
        setPlayerTarget(players[msg.id], msg.x, msg.y);
      }
      break;

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

    case "player-left":
      if (players[msg.id]) {
        addSystemMessage(`${players[msg.id].name} left.`);
        removePlayer(msg.id);
      }
      break;

    case "rename":
      if (role === "host" && fromConn) {
        applyRename(msg.id, msg.name, fromConn);
      } else {
        applyRename(msg.id, msg.name);
      }
      break;

    case "mulch-spawn":
      if (!mulchPieces.some((m) => m.id === msg.piece.id)) {
        mulchPieces.push({ ...msg.piece });
      }
      break;

    case "mulch-collect":
      mulchPieces = mulchPieces.filter((m) => m.id !== msg.mulchId);
      if (players[msg.playerId]) {
        players[msg.playerId].mulch = msg.mulch;
      }
      updateLeaderboard();
      break;

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

function applyWelcome(msg) {
  connectedToHost = true;
  migrating = false;
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

function startMulchSpawning() {
  if (role !== "host" || mulchSpawnInterval) return;
  mulchSpawnInterval = setInterval(() => {
    if (role === "host" && canvas.width > 0 && canvas.height > 0) {
      spawnMulch();
    }
  }, MULCH_SPAWN_INTERVAL_MS);
}

function stopMulchSpawning() {
  if (mulchSpawnInterval) {
    clearInterval(mulchSpawnInterval);
    mulchSpawnInterval = null;
  }
}

function spawnMulch() {
  const padding = MULCH_SIZE / 2 + PLAYER_HALF;
  const maxX = canvas.width - padding;
  const maxY = canvas.height - padding;
  if (maxX <= padding || maxY <= padding) return;

  const piece = {
    id: crypto.randomUUID(),
    x: padding + Math.random() * (maxX - padding),
    y: padding + Math.random() * (maxY - padding),
  };

  mulchPieces.push(piece);
  broadcast({ type: "mulch-spawn", piece });
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

function collectMulch(playerId, mulchId) {
  const pieceIndex = mulchPieces.findIndex((m) => m.id === mulchId);
  if (pieceIndex === -1 || !players[playerId]) return;

  mulchPieces.splice(pieceIndex, 1);
  players[playerId].mulch = (players[playerId].mulch ?? 0) + 1;

  broadcast({
    type: "mulch-collect",
    playerId,
    mulchId,
    mulch: players[playerId].mulch,
  });

  updateLeaderboard();
}

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

function startGameLoop() {
  if (animationId) return;
  lastFrameTime = performance.now();
  function loop(now) {
    const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
    lastFrameTime = now;
    updateLocalPlayer();
    updateRemotePlayers(dt);
    if (role === "host") {
      checkMulchCollisions();
    }
    render();
    animationId = requestAnimationFrame(loop);
  }
  animationId = requestAnimationFrame(loop);
}

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

function updateLocalPlayer() {
  if (!myPlayerId || !players[myPlayerId]) return;

  const p = players[myPlayerId];
  let moved = false;

  if (keys.w) { p.y -= MOVE_SPEED; moved = true; }
  if (keys.s) { p.y += MOVE_SPEED; moved = true; }
  if (keys.a) { p.x -= MOVE_SPEED; moved = true; }
  if (keys.d) { p.x += MOVE_SPEED; moved = true; }

  if (moved) {
    p.x = Math.max(PLAYER_HALF, Math.min(canvas.width - PLAYER_HALF, p.x));
    p.y = Math.max(PLAYER_HALF, Math.min(canvas.height - PLAYER_HALF, p.y));
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
}

function sendMove(x, y) {
  const msg = { type: "move", id: myPlayerId, x, y };
  if (role === "host") {
    broadcast(msg);
  } else if (hostConn && hostConn.open) {
    send(hostConn, msg);
  }
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#2d3f56";
  ctx.lineWidth = 1;
  const gridSize = 40;
  for (let x = 0; x < canvas.width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  for (const piece of mulchPieces) {
    ctx.fillStyle = MULCH_COLOR;
    ctx.fillRect(
      piece.x - MULCH_SIZE / 2,
      piece.y - MULCH_SIZE / 2,
      MULCH_SIZE,
      MULCH_SIZE,
    );
  }

  for (const [id, p] of Object.entries(players)) {
    drawPlayer(id, p);
  }
}

function isChatFocused() {
  return document.activeElement === messageInput || document.activeElement === playerNameInput;
}

function clearMovementKeys() {
  keys.w = keys.a = keys.s = keys.d = false;
}

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

leaveBtn.addEventListener("click", () => {
  leaveSession({ reconnect: true });
});

window.addEventListener("pagehide", () => {
  leaveSession();
});

connect();
