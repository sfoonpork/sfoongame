const ROOM_CODE_RE = /^[A-Z0-9]{4,8}$/;

const PEER_CONFIG = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
};

const JOIN_TIMEOUT_MS = 12000;

const lobby = document.getElementById("lobby");
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
const messages = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const leaveBtn = document.getElementById("leave-btn");

let peer = null;
let conn = null;
let role = null;
let roomCode = null;
let joinTimeout = null;

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

  peer.on("open", () => {
    showRoom();
    setConnectionState("waiting", "Waiting for someone to join…");
  });

  peer.on("connection", (incoming) => {
    if (conn && conn.open) {
      incoming.close();
      return;
    }

    conn = incoming;
    addSystemMessage("A guest joined. Connecting…");
    setConnectionState("waiting", "Connecting to guest…");
    setupConnection(conn);
  });

  peer.on("error", (err) => {
    hostBtn.disabled = false;
    role = null;
    roomCode = null;

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

    conn = peer.connect(code, { reliable: true });
    setupConnection(conn);

    joinTimeout = setTimeout(() => {
      if (!conn || !conn.open) {
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

    if (err.type === "peer-unavailable") {
      setStatus(joinStatus, JOIN_ERRORS["not-found"], "error");
    } else {
      setStatus(joinStatus, JOIN_ERRORS.network, "error");
    }

    destroyPeer();
  });
}

function clearJoinTimeout() {
  if (joinTimeout) {
    clearTimeout(joinTimeout);
    joinTimeout = null;
  }
}

function setupConnection(connection) {
  connection.on("open", () => {
    clearJoinTimeout();
    setConnectionState("connected", "Peer connected");
    messageInput.disabled = false;
    messageForm.querySelector("button").disabled = false;
    addSystemMessage("You are connected. Messages go directly peer-to-peer.");
  });

  connection.on("data", (data) => {
    addChatMessage(String(data), false);
  });

  connection.on("close", () => {
    handleDisconnect();
  });

  connection.on("error", () => {
    if (role === "guest" && !connection.open) {
      clearJoinTimeout();
      setStatus(joinStatus, JOIN_ERRORS["not-found"], "error");
      joinBtn.disabled = false;
      resetToLobby();
    }
  });
}

function handleDisconnect() {
  setConnectionState("disconnected", role === "host" ? "Guest disconnected" : "Host disconnected");
  messageInput.disabled = true;
  messageForm.querySelector("button").disabled = true;
  addSystemMessage(role === "host" ? "Guest left the room." : "Host closed the room.");
  conn = null;
}

function destroyPeer() {
  clearJoinTimeout();
  if (conn) {
    conn.close();
    conn = null;
  }
  if (peer) {
    peer.destroy();
    peer = null;
  }
}

function showRoom() {
  lobby.classList.add("hidden");
  roomView.classList.remove("hidden");
  activeCode.textContent = roomCode;
  roleBadge.textContent = role === "host" ? "Host" : "Guest";
  roleBadge.classList.toggle("guest", role === "guest");
  messages.innerHTML = "";
  if (role === "guest") {
    addSystemMessage("Connecting to room…");
  }
}

function resetToLobby() {
  destroyPeer();
  role = null;
  roomCode = null;
  lobby.classList.remove("hidden");
  roomView.classList.add("hidden");
  hostBtn.disabled = false;
  joinBtn.disabled = false;
  messageInput.disabled = true;
  messageForm.querySelector("button").disabled = true;
  setConnectionState("waiting", "Connecting peer…");
}

function setConnectionState(state, text) {
  connectionStatus.className = `connection ${state}`;
  connectionStatus.textContent = text;
}

function addSystemMessage(text) {
  const el = document.createElement("div");
  el.className = "message system";
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

function addChatMessage(text, isLocal) {
  const el = document.createElement("div");
  el.className = `message ${isLocal ? "local" : "remote"}`;
  el.textContent = text;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

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
  if (!text || !conn || !conn.open) return;
  conn.send(text);
  addChatMessage(text, true);
  messageInput.value = "";
});

leaveBtn.addEventListener("click", () => {
  resetToLobby();
  setStatus(hostStatus, "");
  setStatus(joinStatus, "");
});
