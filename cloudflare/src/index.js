import { DurableObject } from "cloudflare:workers";
import { buildPushPayload } from "@block65/webcrypto-web-push";

const APP_ORIGIN = "https://a09848281-prog.github.io";
const UPSTREAM_WS = "wss://api.p2pquake.net/v2/ws";
const MAX_SUBSCRIPTIONS = 50;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin === APP_ORIGIN ? APP_ORIGIN : "null",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function json(data, status = 200, origin = APP_ORIGIN) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) }
  });
}

function scaleLabel(value) {
  const labels = {
    0:"0",10:"1",20:"2",30:"3",40:"4",45:"5弱",46:"5弱以上（推定）",
    50:"5強",55:"6弱",60:"6強",70:"7",99:"程度以上"
  };
  return labels[Number(value)] || "不明";
}

function describeMessage(data) {
  const code = Number(data?.code);
  if (!data || ![551, 554, 556].includes(code)) return null;
  if (data.test) return null;

  const isEew = code === 556;
  const isDetection = code === 554;
  const quake = data.earthquake || {};
  const hypo = quake.hypocenter || {};
  const cancelled = isEew && data.cancelled === true;
  const place = String(hypo.name || hypo.reduceName || "震源情報を確認中");
  const magnitude = Number(hypo.magnitude);
  const eewScales = Array.isArray(quake.areas)
    ? quake.areas.map(area => Number(area.scaleTo)).filter(value => Number.isFinite(value) && value >= 0)
    : [];
  const scaleValue = isEew
    ? (eewScales.length ? Math.max(...eewScales) : null)
    : hypo.maxScale;
  const scale = scaleValue === null || scaleValue === undefined ? "不明" : scaleLabel(scaleValue);
  const time = String(quake.originTime || quake.time || "");
  const magText = Number.isFinite(magnitude) && magnitude >= 0 ? "M" + magnitude.toFixed(1) : "M不明";
  const title = isDetection
    ? "緊急地震速報を検知"
    : cancelled ? "緊急地震速報・取消"
    : isEew ? "緊急地震速報（警報）" : "地震情報";
  const details = [
    place,
    magText,
    scale === "不明" ? "予測震度不明" : (isEew ? "予測最大震度 " : "最大震度 ") + scale,
    time ? "発生 " + time : ""
  ].filter(Boolean);
  return {
    id: String(data.id || data.time || Date.now()),
    code,
    title,
    body: isDetection
      ? "緊急地震速報の発表を検知しました。詳細情報を受信中です。"
      : cancelled ? "発表されていた緊急地震速報が取り消されました。" : details.join(" / "),
    url: "/",
    urgency: isEew || isDetection ? "high" : "normal",
    event: {
      code,
      id: String(data.id || ""),
      title,
      hypocenter: place,
      magnitude: Number.isFinite(magnitude) && magnitude >= 0 ? magnitude : null,
      maxIntensity: scale,
      originTime: time,
      latitude: hypo.latitude !== undefined && hypo.latitude !== null && Number.isFinite(Number(hypo.latitude)) && Number(hypo.latitude) > -90 ? Number(hypo.latitude) : null,
      longitude: hypo.longitude !== undefined && hypo.longitude !== null && Number.isFinite(Number(hypo.longitude)) && Number(hypo.longitude) > -180 ? Number(hypo.longitude) : null,
      depthKm: hypo.depth !== undefined && hypo.depth !== null && Number.isFinite(Number(hypo.depth)) && Number(hypo.depth) >= 0 ? Number(hypo.depth) : null,
      cancelled
    }
  };
}

export class EarthquakeHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.upstream = null;
    this.connectedAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/live" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      this.ensureUpstream().catch(error => console.error("Upstream start failed", error));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/internal/subscribe" && request.method === "POST") {
      const subscription = await request.json();
      if (!subscription || typeof subscription.endpoint !== "string" ||
          !subscription.endpoint.startsWith("https://") ||
          !subscription.keys?.p256dh || !subscription.keys?.auth) {
        return Response.json({ ok:false, error:"Invalid push subscription" }, { status:400 });
      }
      const subscriptions = await this.ctx.storage.get("subscriptions") || [];
      const next = subscriptions.filter(item => item.endpoint !== subscription.endpoint);
      if (next.length >= MAX_SUBSCRIPTIONS) {
        return Response.json({ ok:false, error:"Subscription limit reached" }, { status:429 });
      }
      next.push(subscription);
      await this.ctx.storage.put("subscriptions", next);
      this.ensureUpstream().catch(error => console.error("Upstream start failed", error));
      return Response.json({ ok:true, count:next.length });
    }

    if (url.pathname === "/internal/ensure") {
      await this.ensureUpstream();
      return Response.json({
        ok:true,
        connected: !!this.upstream && this.upstream.readyState === WebSocket.OPEN,
        clients:this.ctx.getWebSockets().length
      });
    }

    if (url.pathname === "/internal/status") {
      return Response.json({
        ok:true,
        connected: !!this.upstream && this.upstream.readyState === WebSocket.OPEN,
        subscriptions:(await this.ctx.storage.get("subscriptions") || []).length,
        clients:this.ctx.getWebSockets().length
      });
    }

    return new Response("Not found", { status:404 });
  }

  async ensureUpstream() {
    if (this.upstream &&
        (this.upstream.readyState === WebSocket.OPEN || this.upstream.readyState === WebSocket.CONNECTING) &&
        Date.now() - this.connectedAt < 12 * 60 * 1000) return;

    if (this.upstream) {
      try { this.upstream.close(1000, "scheduled reconnect"); } catch (_) {}
      this.upstream = null;
    }

    try {
      const socket = new WebSocket(UPSTREAM_WS);
      this.upstream = socket;
      this.connectedAt = Date.now();

      socket.addEventListener("message", async event => {
        try {
          await this.handleUpstreamMessage(event.data);
        } catch (error) {
          console.error("Failed to process P2P message", error);
        }
      });
      socket.addEventListener("close", () => {
        if (this.upstream === socket) this.upstream = null;
        this.ctx.storage.setAlarm(Date.now() + 10000).catch(() => {});
      });
      socket.addEventListener("error", () => {
        try { socket.close(); } catch (_) {}
      });
    } catch (error) {
      console.error("P2P WebSocket connection failed", error);
      this.ctx.storage.setAlarm(Date.now() + 15000);
    }
  }

  async alarm() {
    await this.ensureUpstream();
  }

  async handleUpstreamMessage(raw) {
    let data;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch (_) {
      return;
    }

    const notification = describeMessage(data);
    if (!notification) return;

    const key = String(data.code) + ":" + String(data.id || data.time || "");
    if (await this.ctx.storage.get("last:" + key)) return;
    await this.ctx.storage.put("last:" + key, Date.now());
    await this.ctx.storage.put("lastEvent", notification);

    const packet = JSON.stringify({ type:"earthquake", ...notification });
    for (const client of this.ctx.getWebSockets()) {
      try { client.send(packet); } catch (_) {}
    }

    await this.sendPushToAll(notification);
  }

  async sendPushToAll(notification) {
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY || !this.env.VAPID_SUBJECT) {
      console.error("VAPID secrets are not configured");
      return;
    }

    const subscriptions = await this.ctx.storage.get("subscriptions") || [];
    if (!subscriptions.length) return;

    const vapid = {
      subject:this.env.VAPID_SUBJECT,
      publicKey:this.env.VAPID_PUBLIC_KEY,
      privateKey:this.env.VAPID_PRIVATE_KEY
    };

    const remaining = [];
    for (const subscription of subscriptions) {
      try {
        const request = await buildPushPayload({
          data:JSON.stringify(notification),
          options:{ ttl:120, urgency:notification.urgency || "high" }
        }, subscription, vapid);
        const response = await fetch(subscription.endpoint, request);
        if (response.status !== 404 && response.status !== 410) remaining.push(subscription);
      } catch (error) {
        console.error("Push delivery failed", error);
        remaining.push(subscription);
      }
    }
    await this.ctx.storage.put("subscriptions", remaining);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status:204, headers:corsHeaders(origin) });
    }
    if (origin && origin !== APP_ORIGIN) return json({ok:false,error:"Origin not allowed"}, 403, origin);

    const id = env.EARTHQUAKE_HUB.idFromName("global");
    const hub = env.EARTHQUAKE_HUB.get(id);

    if (url.pathname === "/live") {
      return hub.fetch(request);
    }

    if (url.pathname === "/api/config" && request.method === "GET") {
      return json({ok:true, publicKey:env.VAPID_PUBLIC_KEY || ""}, 200, origin);
    }

    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      if (!env.APP_TOKEN || request.headers.get("Authorization") !== "Bearer " + env.APP_TOKEN) {
        return json({ok:false,error:"登録トークンが正しくありません。"}, 401, origin);
      }
      const body = await request.text();
      const response = await hub.fetch(new Request("https://hub.internal/internal/subscribe", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body
      }));
      const result = await response.json();
      return json(result, response.status, origin);
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      const response = await hub.fetch("https://hub.internal/internal/status");
      return json(await response.json(), response.status, origin);
    }

    return json({ok:false,error:"Not found"}, 404, origin);
  },

  async scheduled(_event, env, ctx) {
    const id = env.EARTHQUAKE_HUB.idFromName("global");
    const hub = env.EARTHQUAKE_HUB.get(id);
    ctx.waitUntil(hub.fetch("https://hub.internal/internal/ensure"));
  }
};
