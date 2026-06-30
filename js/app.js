const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

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

const lobby = document.getElementById("lobby");
const lobbyHeader = document.getElementById("lobby-header");
const roomView = document.getElementById("room");
const hostCode = document.getElementById("host-code");
const joinCode = document.getElementById("join-code");
const hostBtn = document.getElementById("host-btn");
const joinBtn = document.getElementById("join-btn");
const hostStatus = document.getElementById("host-status");
const joinStatus = document.getElementById("join-status");
const activeCode = document.getElementById("active-code");
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
let role = null;
let roomCode = null;
let joinTimeout = null;
let myPlayerId = null;
let players = {};
let animationId = null;
let lastMoveSent = 0;
let lastSentPos = { x: 0, y: 0 };
let connectedToHost = false;

const keys = { w: false, a: false, s: false, d: false };

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`${tab.dataset.tab}-panel`).classList.add("active");
  });
});

function normalizeCode(input) {
  return input.value.trim().toUpperCase();
}

function setStatus(el, text, type) {
  el.textContent = text;
  el.className = "status" + (type ? ` ${type}` : "");
}

const HOST_ERRORS = {
  invalid: "Invalid room code. Use 4–8 letters or numbers.",
  "in-use": "That room code is already in use. Try another.",
  network: "Could not reach the network. Check your connection and try again.",
};

const JOIN_ERRORS = {
  invalid: "Invalid room code. Use 4–8 letters or numbers.",
  "not-found": "No room found with that code.",
  full: "This room is full.",
  network: "Could not reach the network. Check your connection and try again.",
};

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

function hostRoom() {
  const code = normalizeCode(hostCode);
  hostCode.value = code;
  setStatus(hostStatus, "");

  if (!ROOM_CODE_RE.test(code)) {
    setStatus(hostStatus, HOST_ERRORS.invalid, "error");
    return;
  }

  hostBtn.disabled = true;
  role = "host";
  roomCode = code;

  peer = new Peer(code, PEER_CONFIG);

  peer.on("open", (id) => {
    myPlayerId = id;
    showRoom();
    spawnPlayer(id, "Host");
    startGameLoop();
    setConnectionState("connected", "Hosting — waiting for players");
    addSystemMessage("You are hosting. Share the room code to invite others.");
    updatePlayerCount();
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
    hostBtn.disabled = false;
    role = null;
    roomCode = null;
    myPlayerId = null;

    if (err.type === "unavailable-id") {
      setStatus(hostStatus, HOST_ERRORS["in-use"], "error");
    } else if (err.type === "invalid-id") {
      setStatus(hostStatus, HOST_ERRORS.invalid, "error");
    } else {
      setStatus(hostStatus, HOST_ERRORS.network, "error");
    }

    destroyPeer();
  });
}

function joinRoom() {
  const code = normalizeCode(joinCode);
  joinCode.value = code;
  setStatus(joinStatus, "");

  if (!ROOM_CODE_RE.test(code)) {
    setStatus(joinStatus, JOIN_ERRORS.invalid, "error");
    return;
  }

  joinBtn.disabled = true;
  role = "guest";
  roomCode = code;

  peer = new Peer(PEER_CONFIG);

  peer.on("open", () => {
    showRoom();
    setConnectionState("waiting", "Connecting to host…");

    hostConn = peer.connect(code, { reliable: true });
    setupHostConnection(hostConn);

    joinTimeout = setTimeout(() => {
      if (!connectedToHost) {
        setStatus(joinStatus, JOIN_ERRORS["not-found"], "error");
        joinBtn.disabled = false;
        resetToLobby();
      }
    }, JOIN_TIMEOUT_MS);
  });

  peer.on("error", (err) => {
    clearJoinTimeout();
    joinBtn.disabled = false;
    role = null;
    roomCode = null;
    myPlayerId = null;

    if (err.type === "peer-unavailable") {
      setStatus(joinStatus, JOIN_ERRORS["not-found"], "error");
    } else {
      setStatus(joinStatus, JOIN_ERRORS.network, "error");
    }

    destroyPeer();
  });
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

function setupGuestConnection(connection) {
  connections.set(connection.peer, connection);

  connection.on("open", () => {
    const guestId = connection.peer;
    const guestNum = connections.size;
    spawnPlayer(guestId, `Player ${guestNum}`);

    send(connection, { type: "welcome", id: guestId, players: getPlayersSnapshot() });
    broadcast({ type: "player-joined", id: guestId, player: players[guestId] }, connection);

    addSystemMessage(`${players[guestId].name} joined.`);
    updatePlayerCount();
    updateConnectionStatus();
  });

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
    connectedToHost = true;
    setConnectionState("waiting", "Waiting for game state…");
    send(connection, { type: "hello" });
  });

  connection.on("data", (data) => {
    handleMessage(data, connection);
  });

  connection.on("close", () => {
    handleHostDisconnect();
  });

  connection.on("error", () => {
    if (!connectedToHost) {
      clearJoinTimeout();
      setStatus(joinStatus, JOIN_ERRORS["not-found"], "error");
      joinBtn.disabled = false;
      resetToLobby();
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
      if (role === "host") break;
      break;

    case "welcome":
      if (role !== "guest") break;
      myPlayerId = msg.id;
      players = {};
      for (const [id, p] of Object.entries(msg.players)) {
        players[id] = { ...p };
      }
      startGameLoop();
      enableChat();
      setConnectionState("connected", "Connected to host");
      addSystemMessage("You joined the game. Use WASD to move.");
      updatePlayerCount();
      break;

    case "error":
      if (msg.reason === "full") {
        setStatus(joinStatus, JOIN_ERRORS.full, "error");
        joinBtn.disabled = false;
        resetToLobby();
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

    case "host-left":
      handleHostDisconnect();
      break;
  }
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
    snapshot[id] = { x: p.x, y: p.y, color: p.color, name: p.name };
  }
  return snapshot;
}

function handleGuestDisconnect(connection) {
  const guestId = connection.peer;
  connections.delete(guestId);

  if (players[guestId]) {
    addSystemMessage(`${players[guestId].name} left.`);
    broadcast({ type: "player-left", id: guestId });
    removePlayer(guestId);
  }

  updateConnectionStatus();
}

function handleHostDisconnect() {
  if (role !== "guest") return;
  setConnectionState("disconnected", "Host disconnected");
  disableChat();
  addSystemMessage("Host closed the room.");
  stopGameLoop();
  connectedToHost = false;
  hostConn = null;
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

function clearJoinTimeout() {
  if (joinTimeout) {
    clearTimeout(joinTimeout);
    joinTimeout = null;
  }
}

function enableChat() {
  messageInput.disabled = false;
  messageForm.querySelector("button").disabled = false;
}

function disableChat() {
  messageInput.disabled = true;
  messageForm.querySelector("button").disabled = true;
}

function destroyPeer() {
  clearJoinTimeout();
  stopGameLoop();

  if (role === "host" && connections.size > 0) {
    broadcast({ type: "host-left" });
  }

  for (const conn of connections.values()) {
    conn.close();
  }
  connections.clear();

  if (hostConn) {
    hostConn.close();
    hostConn = null;
  }

  if (peer) {
    peer.destroy();
    peer = null;
  }

  players = {};
  myPlayerId = null;
  connectedToHost = false;
  keys.w = keys.a = keys.s = keys.d = false;
}

function showRoom() {
  document.body.classList.add("in-room");
  lobbyHeader.classList.add("hidden");
  lobby.classList.add("hidden");
  roomView.classList.remove("hidden");
  activeCode.textContent = roomCode;
  roleBadge.textContent = role === "host" ? "Host" : "Guest";
  roleBadge.classList.toggle("guest", role === "guest");
  messages.innerHTML = "";
  resizeCanvas();
  if (role === "guest") {
    addSystemMessage("Connecting to room…");
  }
}

function resetToLobby() {
  destroyPeer();
  role = null;
  roomCode = null;
  document.body.classList.remove("in-room");
  lobbyHeader.classList.remove("hidden");
  lobby.classList.remove("hidden");
  roomView.classList.add("hidden");
  hostBtn.disabled = false;
  joinBtn.disabled = false;
  disableChat();
  setConnectionState("waiting", "Connecting…");
  updatePlayerCount();
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
  if (!myPlayerId || roomView.classList.contains("hidden")) return;
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

window.addEventListener("resize", () => {
  if (!roomView.classList.contains("hidden")) {
    resizeCanvas();
  }
});

hostBtn.addEventListener("click", hostRoom);
joinBtn.addEventListener("click", joinRoom);

hostCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") hostRoom();
});
joinCode.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});

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
  resetToLobby();
  setStatus(hostStatus, "");
  setStatus(joinStatus, "");
});
