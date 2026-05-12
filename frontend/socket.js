// Socket.io client bootstrap (non-module for compatibility with index.html).
(function () {
  const backendUrl = "http://localhost:5000";

  window.personaFlow = window.personaFlow || {};

  const socket = io(backendUrl);
  window.personaFlow.socket = socket;
  window.personaFlow.latestClothingFeatures = null;
  window.personaFlow.latestPositions = null;
  window.personaFlow.myCharId = null;

  socket.on("connect", () => {
    console.log("[personaFlow] connected:", backendUrl);
    socket.emit("client_event", { type: "frontend_ready", ts: Date.now() });
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
