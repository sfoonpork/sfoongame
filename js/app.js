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
const PLAYER_RADIUS = 8;
const MOVE_SEND_INTERVAL_MS = 50;
const HOST_MIGRATION_DELAY_MS = 500;
const GUEST_RECONNECT_DELAY_MS = 2500;
const RECONNECT_RETRY_MS = 3000;

const PLAYER_COLORS = [
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

const roleBadge = document.getElementById("role-badge");
const connectionStatus = document.getElementById("connection-status");
const playerCountEl = document.getElementById("player-count");
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
let nextJoinOrder = 1;
let animationId = null;
let lastMoveSent = 0;
let lastSentPos = { x: 0, y: 0 };
let connectedToHost = false;
let migrating = false;
let hasJoinedOnce = false;
let intentionalLeave = false;

const keys = { w: false, a: false, s: false, d: false };

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

function destroyPeer({ keepPlayers = false, keepMessages = false } = {}) {
  clearJoinTimeout();
  clearReconnectTimeout();
  intentionalLeave = false;

  if (!keepPlayers) {
    stopGameLoop();
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
  }

  connectedToHost = false;
  migrating = false;
  keys.w = keys.a = keys.s = keys.d = false;

  if (!keepMessages) {
    messages.innerHTML = "";
  }
}

function connect() {
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
    spawnPlayer(myPlayerId, "Host");
    players[myPlayerId].joinOrder = 0;
    nextJoinOrder = 1;
  } else {
    players[myPlayerId].name = "Host";
  }
  players[myPlayerId].isHost = true;

  startGameLoop();
  enableChat();
  updateRoleBadge();
  updatePlayerCount();
  updateConnectionStatus();

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
    send(connection, { type: "hello", playerId: myPlayerId });
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
      handleGuestHello(fromConn, msg.playerId);
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
        players[msg.id].x = msg.x;
        players[msg.id].y = msg.y;
      }
      break;

    case "player-joined":
      players[msg.id] = { ...msg.player };
      addSystemMessage(`${msg.player.name} joined.`);
      updatePlayerCount();
      break;

    case "player-left":
      if (players[msg.id]) {
        addSystemMessage(`${players[msg.id].name} left.`);
        removePlayer(msg.id);
      }
      break;
  }
}

function handleGuestHello(connection, playerId) {
  const isReconnect = !!players[playerId];

  if (!isReconnect) {
    if (Object.keys(players).length >= MAX_PLAYERS) {
      send(connection, { type: "error", reason: "full" });
      connection.close();
      return;
    }
    spawnPlayer(playerId, `Player ${Object.keys(players).length}`);
    players[playerId].joinOrder = nextJoinOrder++;
  }

  connToPlayer.set(connection.peer, playerId);
  send(connection, { type: "welcome", playerId, players: getPlayersSnapshot() });

  if (!isReconnect) {
    broadcast({ type: "player-joined", id: playerId, player: players[playerId] }, connection);
    addSystemMessage(`${players[playerId].name} joined.`);
  }

  updatePlayerCount();
  updateConnectionStatus();
}

function applyWelcome(msg) {
  connectedToHost = true;
  migrating = false;
  clearReconnectTimeout();

  for (const [id, p] of Object.entries(msg.players)) {
    players[id] = { ...p };
  }

  if (!players[myPlayerId]) {
    const center = getCanvasCenter();
    players[myPlayerId] = {
      x: center.x,
      y: center.y,
      color: PLAYER_COLORS[Object.keys(players).length % PLAYER_COLORS.length],
      name: role === "host" ? "Host" : `Player ${Object.keys(players).length}`,
      joinOrder: nextJoinOrder++,
    };
  }

  startGameLoop();
  enableChat();
  updateRoleBadge();
  setConnectionState("connected", "Connected");
  updatePlayerCount();

  if (!hasJoinedOnce) {
    addSystemMessage("Use WASD to move.");
    hasJoinedOnce = true;
  }
}

function spawnPlayer(id, name) {
  const center = getCanvasCenter();
  players[id] = {
    x: center.x,
    y: center.y,
    color: PLAYER_COLORS[Object.keys(players).length % PLAYER_COLORS.length],
    name,
  };
}

function removePlayer(id) {
  delete players[id];
  updatePlayerCount();
}

function applyMove(id, x, y) {
  if (players[id]) {
    players[id].x = x;
    players[id].y = y;
  }
}

function getPlayersSnapshot() {
  const snapshot = {};
  for (const [id, p] of Object.entries(players)) {
    snapshot[id] = {
      x: p.x,
      y: p.y,
      color: p.color,
      name: p.name,
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

function handleGuestDisconnect(connection) {
  const playerId = connToPlayer.get(connection.peer);
  connections.delete(connection.peer);
  connToPlayer.delete(connection.peer);

  if (playerId && players[playerId]) {
    addSystemMessage(`${players[playerId].name} left.`);
    broadcast({ type: "player-left", id: playerId });
    removePlayer(playerId);
  }

  updateConnectionStatus();
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
  destroyPeer({ keepPlayers: true, keepMessages: true });
  migrating = true;
  setConnectionState("waiting", "Becoming host…");

  removeHostPlayer();
  if (players[myPlayerId]) {
    players[myPlayerId].isHost = true;
    players[myPlayerId].name = "Host";
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
}

function disableChat() {
  messageInput.disabled = true;
  messageForm.querySelector("button").disabled = true;
}

function setConnectionState(state, text) {
  connectionStatus.className = `connection ${state}`;
  connectionStatus.textContent = text;
}

function updatePlayerCount() {
  const count = Object.keys(players).length;
  playerCountEl.textContent = count === 1 ? "1 player" : `${count} players`;
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
  function loop() {
    updateLocalPlayer();
    render();
    animationId = requestAnimationFrame(loop);
  }
  loop();
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
    p.x = Math.max(PLAYER_RADIUS, Math.min(canvas.width - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(canvas.height - PLAYER_RADIUS, p.y));

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

  for (const [id, p] of Object.entries(players)) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();

    if (id === myPlayerId) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = "#e8edf4";
    ctx.font = "11px Segoe UI, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(p.name, p.x, p.y - PLAYER_RADIUS - 4);
  }
}

window.addEventListener("keydown", (e) => {
  if (!myPlayerId) return;
  const key = e.key.toLowerCase();
  if (key in keys) {
    keys[key] = true;
    e.preventDefault();
  }
});

window.addEventListener("keyup", (e) => {
  const key = e.key.toLowerCase();
  if (key in keys) {
    keys[key] = false;
    e.preventDefault();
  }
});

window.addEventListener("resize", resizeCanvas);

messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  const fromName = players[myPlayerId]?.name || (role === "host" ? "Host" : "Guest");
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
  intentionalLeave = true;
  hasJoinedOnce = false;
  sessionStorage.removeItem("playerId");
  destroyPeer();
  connect();
});

connect();
