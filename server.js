const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");

// -----------------
// Data Structures
// -----------------
const groups = new Map();        // scaleId → Set<ws>
const lastWeight = new Map();    // scaleId → lastWeightValue

// -----------------
// Create WS server
// -----------------
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// -----------------
// Helper: Get client IP
// -----------------
function getClientIp(ws) {
  return ws._socket.remoteAddress;
}

// -----------------
// MAIN CONNECTION HANDLER
// -----------------
wss.on("connection", (ws, req) => {
  ws.type = null;
  ws.scaleId = null;
  ws.deviceId = null;
  ws.ip = getClientIp(ws);
  ws.lastActivity = Date.now();

  console.log(`WS connected from ${ws.ip}`);

  ws.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg.toString()); }
    catch { return; }

    const { action, scaleId, weight, deviceId } = data;

    // ----------------------
    // REGISTER BRIDGE
    // ----------------------
    if (action === "register-bridge") {
      if (!scaleId)
        return ws.send(JSON.stringify({ error: "Missing Scale ID" }));

      ws.type = "bridge";
      ws.scaleId = scaleId;
      ws.deviceId = deviceId;
      ws.lastActivity = Date.now();

      let group = groups.get(scaleId);

      if (!group) {
        group = new Set();
        groups.set(scaleId, group);
      }

      //-----------------------------------------------------------------
      // RULE 1: Reject if another PC is using the same scale
      //-----------------------------------------------------------------
      for (const c of group) {
        if (c.type === "bridge" && c.deviceId !== ws.deviceId) {
          return ws.send(
            JSON.stringify({
              status: `Scale ${scaleId} already in use by another PC`
            })
          );
        }
      }

      //-----------------------------------------------------------------
      // RULE 2: Find existing connection from same PC (bridge only)
      //-----------------------------------------------------------------
      let existing = null;

      for (const g of groups.values()) {
        for (const c of g) {
          if (c.type === "bridge" && c.deviceId === ws.deviceId) {
            if (c.readyState !== WebSocket.OPEN) {
              g.delete(c);
              continue;
            }

            existing = c;
            break;
          }
        }
        if (existing) break;
      }

      //-----------------------------------------------------------------
      // RULE 2A: Same PC but different scale → REJECT
      //-----------------------------------------------------------------
      if (existing && existing.scaleId !== scaleId) {
        return ws.send(
          JSON.stringify({
            status: `This PC is already connected with scale ${existing.scaleId}, cannot register ${scaleId}`
          }),
          () => ws.close(4004, "Scale mismatch – cannot merge")
        );
      }

      //-----------------------------------------------------------------
      // RULE 2B: Same PC, same scale → MERGE
      //-----------------------------------------------------------------
      if (existing) {
        console.log(`Merging duplicate bridge from PC ${deviceId} for scale ${scaleId}`);

        existing.type = "bridge";
        existing.scaleId = scaleId;
        existing.deviceId = deviceId;
        existing.lastActivity = Date.now();

        // ensure existing stays in same group
        group.add(existing);

        return ws.send(
          JSON.stringify({ status: "Merged into existing connection" }),
          () => ws.close(4003, "Merged")
        );
      }

      //-----------------------------------------------------------------
      // RULE 3: New connection from this PC
      //-----------------------------------------------------------------
      group.add(ws);

      ws.send(JSON.stringify({ status: `Bridge registered for ${scaleId}` }));
      console.log(`Bridge registered for ${scaleId}`);
      return;
    }




    // ----------------------
    // DISCONNECT BRIDGE
    // ----------------------
    if (action === "disconnect-bridge") {
      if (!scaleId)
        return ws.send(JSON.stringify({ error: "Missing Scale ID" }));

      const group = groups.get(scaleId);
      if (!group) return;

      console.log(`Disconnecting all for scale ${scaleId}`);

      for (const c of [...group]) {
        if (c.readyState === WebSocket.OPEN) {
          c.close(4001, "Scale disconnected");
        }
        group.delete(c);
      }

      groups.delete(scaleId);
      return ws.send(JSON.stringify({ status: `Bridge disconnected ${scaleId}`}));
    }

    // ----------------------
    // REGISTER CLIENT
    // ----------------------
    if (action === "register-client") {
      if (!scaleId)
        return ws.send(JSON.stringify({ error: "Missing Scale ID" }));

      if (!groups.has(scaleId))
        return ws.send(JSON.stringify({ status: `No scale registered for ${scaleId}` }));

      ws.type = "client";
      ws.scaleId = scaleId;
      ws.deviceId = deviceId;
      ws.lastActivity = Date.now();

      groups.get(scaleId).add(ws);

      ws.send(JSON.stringify({ status: `Client registered for ${scaleId}` }));
      console.log(`Client registered for ${scaleId}`);
      return;
    }

    // ----------------------
    // DISCONNECT CLIENT
    // ----------------------
    if (action === "disconnect-client") {
      if (!scaleId)
        return ws.send(JSON.stringify({ error: "Missing Scale ID" }));

      const group = groups.get(scaleId);
      if (!group) return;

      console.log(`Disconnecting all for scale ${scaleId}`);

      for (const c of [...group]) {
        if (c.readyState === WebSocket.OPEN && c.type == "client") {
          c.close(4001, "Scale disconnected");
          group.delete(c);
        }
      }

      ws.send(JSON.stringify({ status: `Client disconnected ${scaleId}` }));
      return;
    }

    // ----------------------
    // WEIGHT
    // ----------------------
    if (action === "weight") {
      if (weight === undefined) return;

      if (lastWeight.get(scaleId) === weight) return;
      lastWeight.set(scaleId, weight);

      const group = groups.get(scaleId);
      if (!group) return;

      for (const c of group) {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ weight }));
        }
      }
      return;
    }
  });

  // -----------------
  // Activity Timeout Cleanup (1 hour)
  // -----------------
  const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

  setInterval(() => {
    for (const [scaleId, group] of groups) {
      for (const ws of [...group]) {
        if (!ws.lastActivity) continue;

        if (Date.now() - ws.lastActivity > TIMEOUT_MS) {
          console.log(`Timeout: closing inactive connection (${ws.type}) on scale ${scaleId}`);

          ws.close(4002, "Inactive for 1 hour");
          group.delete(ws);
        }
      }

      if (group.size === 0) {
        groups.delete(scaleId);
      }
    }
  }, TIMEOUT_MS);

  // CLEANUP ON CLOSE
  ws.on("close", () => {
    if (ws.scaleId && groups.has(ws.scaleId)) {
      groups.get(ws.scaleId).delete(ws);
    }
  });
});

// -----------------
// Start WS server
// -----------------
server.listen(8080, () => {
  console.log("WS server running at ws://localhost:8080");
});
