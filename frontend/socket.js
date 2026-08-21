// Socket.io client bootstrap (non-module for compatibility with index.html).
(function () {
  // Auto-detect backend host: use current page hostname for LAN access (venue demo),
  // fall back to localhost for local dev.
  const host = window.location.hostname || "127.0.0.1";
  const backendUrl = `http://${host}:5001`;

  window.personaFlow = window.personaFlow || {};

  const socket = io(backendUrl, {
    transports: ["websocket"],
    reconnectionAttempts: 10,
  });
  window.personaFlow.socket = socket;
  window.personaFlow.latestClothingFeatures = null;
  window.personaFlow.latestPositions = null;
  window.personaFlow.myCharId = null;
  window.personaFlow.connected = false;

  socket.on("connect", () => {
    console.log("[personaFlow] connected via websocket:", backendUrl);
    window.personaFlow.connected = true;
    socket.emit("client_event", { type: "frontend_ready", ts: Date.now() });
    window.dispatchEvent(new CustomEvent("socket_connected", { detail: { sid: socket.id } }));
    // Re-join swarm on reconnect if user had already joined
    if (window.personaFlow._lastJoinPayload) {
      console.log("[personaFlow] reconnected — re-joining swarm");
      socket.emit("join_swarm", window.personaFlow._lastJoinPayload);
    }
  });

  socket.on("disconnect", (reason) => {
    console.warn("[personaFlow] disconnected:", reason);
    window.personaFlow.connected = false;
    window.dispatchEvent(new CustomEvent("socket_disconnected", { detail: { reason } }));
  });

  socket.on("connect_error", (err) => {
    console.error("[personaFlow] connection error:", err);
    window.personaFlow.connected = false;
    window.dispatchEvent(new CustomEvent("socket_connect_error", { detail: { error: err } }));
  });

  socket.on("server_message", (data) => {
    console.log("[personaFlow] server_message:", data);
  });

  socket.on("clothing_features", (payload) => {
    window.personaFlow.latestClothingFeatures = payload;
    window.dispatchEvent(new CustomEvent("clothing_features", { detail: payload }));
  });

  socket.on("swarm_joined", (payload) => {
    window.personaFlow.myCharId = payload.id;
    console.log("[personaFlow] swarm_joined:", payload.id);
  });

  socket.on("update_positions", (payload) => {
    window.personaFlow.latestPositions = payload.characters;
    window.dispatchEvent(new CustomEvent("update_positions", { detail: payload }));
  });

  socket.on("avatar_generated", (payload) => {
    window.dispatchEvent(new CustomEvent("avatar_generated", { detail: payload }));
  });
})();
