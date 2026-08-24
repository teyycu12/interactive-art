// Socket.io client bootstrap (non-module for compatibility with index.html).
(function () {
  // Auto-detect backend host: use current page hostname for LAN access (venue demo),
  // fall back to localhost for local dev.
  const host = window.location.hostname || "127.0.0.1";
  const backendUrl = `http://${host}:5001`;

  window.personaFlow = window.personaFlow || {};

  // 不設 reconnectionAttempts（預設 Infinity）：原本設 10 次，在預設退避下
  // 約 45 秒就永久放棄，後端重啟只要久一點，前端就再也連不回來、必須手動
  // 重新整理。退避上限 5 秒代表最多每 5 秒重試一次，成本可忽略。
  const socket = io(backendUrl, {
    transports: ["websocket"],
    reconnectionDelayMax: 5000,
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
      try {
        const saved = sessionStorage.getItem("personaFlow.charId");
        if (saved) window.personaFlow._lastJoinPayload.id = saved;
      } catch (e) { /* sessionStorage 不可用時照舊送出 */ }
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
    // 角色 id 已與連線 id 脫鉤，重新連線時要帶回同一個 id 認領原本的角色，
    // 否則會在牆上多出一個分身。sessionStorage 的範圍剛好是「這個分頁」，
    // 與一位賓客一次參與的生命週期一致。
    try {
      sessionStorage.setItem("personaFlow.charId", payload.id);
    } catch (e) { /* 無痕模式等情境下不可用，略過即可 */ }
    if (window.personaFlow._lastJoinPayload) {
      window.personaFlow._lastJoinPayload.id = payload.id;
    }
    console.log("[personaFlow] swarm_joined:", payload.id);
  });

  socket.on("update_positions", (payload) => {
    window.personaFlow.latestPositions = payload.characters;
    window.dispatchEvent(new CustomEvent("update_positions", { detail: payload }));
  });

  socket.on("avatar_generated", (payload) => {
    window.dispatchEvent(new CustomEvent("avatar_generated", { detail: payload }));
  });

  socket.on("generation_progress", (payload) => {
    window.dispatchEvent(new CustomEvent("generation_progress", { detail: payload }));
  });
})();
