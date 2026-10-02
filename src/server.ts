/**
 * A³ Live Representative MCP server: local businesses on A³ for Alexa+ and other MCP Apps hosts.
 * Tools find providers, open a live video conversation with a business's A³ representative
 * (MCP Apps view + WebSocket relay to the A³ platform), pass a voice host's words into it,
 * and hand the representative's booking back to the assistant. Also serves the Alexa+ simulator.
 * Outside PUBLIC_MODE, the `a3_window_probe` tool checks what a host allows inside a view.
 *
 * Run: PUBLIC_URL=https://<public host> npx tsx src/server.ts
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import cors from "cors";
import express, { type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { buildSync } from "esbuild";
import { simRouter } from "./sim.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = parseInt(process.env.PORT ?? "3401", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const WS_URL = PUBLIC_URL.replace(/^http/, "ws");
const FRAME_URL = "https://app.triplea.studio";
const REPORT_LOG = path.join(ROOT, "probe-reports.jsonl");
const RESOURCE_URI = "ui://a3/window-probe.html";
const TALK_URI = "ui://a3/talk.html";
const PROVIDERS_URI = "ui://a3/providers.html";
const BOOKING_URI = "ui://a3/booking.html";

// Proxy to a3-studio: the MCP App window lives on a foreign origin, and a3-studio only admits ours.
// Session parameters are set by the server; the window does not pass them.
const A3_WS = process.env.A3_WS ?? "wss://a3-studio-736546085932.us-east5.run.app/ws_live";
const A3_ORIGIN = "https://app.triplea.studio";
const A3_TENANT = process.env.A3_TENANT ?? "uid:a3demo";
const A3_AVATAR = process.env.A3_AVATAR ?? "hannah_v1";
// a3-studio returns livekit_config with this host (verified 01.10: wss://lk.triplea.studio).
const LIVEKIT_HOST = process.env.LIVEKIT_HOST ?? "lk.triplea.studio";

// Public address for the judges: no window probe or echo, and avatar conversations are limited because
// each one occupies a production A³ slot (the same slots serve a live clinic).
const PUBLIC_MODE = process.env.PUBLIC_MODE === "1";
const MAX_LIVE = parseInt(process.env.MAX_LIVE_SESSIONS ?? "0", 10); // 0 = no limit
const MAX_LIVE_SECONDS = parseInt(process.env.MAX_LIVE_SECONDS ?? "0", 10);

// Fictional Austin clinics for the hackathon: search, representative, booking.
type Service = { id: string; name: string; price_usd: number; minutes: number; tags: string[] };
type Provider = {
  id: string; name: string; tagline: string; address: string; distance_mi: number; rating: number;
  reviews: number; hours: string; live_rep: boolean; rep_name?: string; avatar_id?: string;
  rep_photo?: string; tenant?: string; services: Service[]; faq: string[];
};
// Until the clinic tenants are set up in A³, all representatives go through the demo tenant.
const FORCE_DEMO_TENANT = process.env.A3_FORCE_DEMO_TENANT === "1";
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "providers.json"), "utf-8")) as {
  city: string; providers: Provider[];
};
const providerById = (id: string) => CATALOG.providers.find((p) => p.id === id);

function matchServices(p: Provider, query: string): Service[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (!words.length) return p.services;
  return p.services.filter((s) => {
    const hay = (s.name + " " + s.tags.join(" ")).toLowerCase();
    return words.some((w) => hay.includes(w));
  });
}

function upstreamUrl(language: string, avatarId: string = A3_AVATAR, tenant: string = A3_TENANT): string {
  const qs = new URLSearchParams({
    mode: "demo",
    stage: "ambassador",
    language,
    avatar_id: avatarId,
    context: "web_embed",
    visitor: "mcp-" + Math.random().toString(36).slice(2, 10),
    tenant,
    framing_bucket: "landscape",
    bench: "ditto",
    webrtc: "1",
    src: "claude_mcp_app",
  });
  return `${A3_WS}?${qs}`;
}

// Open conversations with representatives. A voice host (Alexa) listens to the person itself
// and passes the question as text: it goes to the most recent open conversation of this clinic.
type LiveSession = { provider: string; upstream: WebSocket; openedAt: number; started: boolean; customerShared: boolean };
const liveSessions = new Set<LiveSession>();
// Conversation outcome for the voice host: the latest booking the representative confirmed with a card
// (content_update booking_confirmation from a3-studio). Kept after the conversation ends: "Alexa, add it
// to my calendar" is said only after the user has said goodbye to the representative.
type Booking = { procedure: string; datetime: string; name: string; venue: string; at: number };
const bookings = new Map<string, Booking>();
function latestSession(provider: string): LiveSession | undefined {
  let best: LiveSession | undefined;
  for (const s of liveSessions) {
    if (s.provider !== provider || !s.started || s.upstream.readyState !== WebSocket.OPEN) continue;
    if (!best || s.openedAt > best.openedAt) best = s;
  }
  return best;
}

// The App library from ext-apps is inlined into the window whole: the window must be a single file.
// Its trailing `export{X as Name,...}` is turned into window.McpApps = {Name: X, ...}.
function buildHtml(template: string): string {
  const lib = fs.readFileSync(
    path.join(ROOT, "node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js"),
    "utf-8",
  );
  const m = lib.match(/export\{([^}]*)\};?\s*$/);
  if (!m) throw new Error("ext-apps bundle: export list not found");
  const pairs = m[1].split(",").map((p) => {
    const [local, name] = p.split(" as ").map((s) => s.trim());
    return `${JSON.stringify(name ?? local)}:${local}`;
  });
  const libScript = lib.slice(0, m.index) + `;window.McpApps={${pairs.join(",")}};`;
  const tpl = fs.readFileSync(path.join(ROOT, "ui", template), "utf-8");
  // LiveKit: avatar video and voice from the Ditto workers travel over WebRTC only.
  const livekit = tpl.includes("/*__LIVEKIT__*/")
    ? fs.readFileSync(path.join(ROOT, "node_modules/livekit-client/dist/livekit-client.umd.js"), "utf-8")
        .replace(/\/\/# sourceMappingURL=.*$/m, "")
    : "";
  return tpl
    .replace("/*__LIB__*/", () => libScript)
    .replace("/*__LIVEKIT__*/", () => livekit)
    .replaceAll("__PUBLIC_URL__", PUBLIC_URL)
    .replaceAll("__WS_URL__", WS_URL)
    .replaceAll("__FRAME_URL__", FRAME_URL);
}

function createServer(): McpServer {
  const server = new McpServer({ name: "A3 Live Representative", version: "0.2.0" });

  if (!PUBLIC_MODE) registerProbe(server);
  registerBusiness(server);
  return server;
}

/** MCP Apps window diagnostics: needed when connecting a new host, not for the judges. */
function registerProbe(server: McpServer) {
  registerAppTool(
    server,
    "a3_window_probe",
    {
      title: "A³ window probe",
      description:
        "Opens a diagnostic window that checks what this chat client allows inside an app window: video, sound, network, WebSocket, microphone, WebRTC and an embedded page. Call it when the user asks to run the A3 probe.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async () => ({
      content: [{ type: "text", text: "A³ probe window opened. Results appear in the window." }],
    }),
  );

  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "A³ window probe" },
    async () => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: buildHtml("probe.html"),
          _meta: {
            ui: {
              csp: {
                connectDomains: [PUBLIC_URL, WS_URL],
                resourceDomains: [PUBLIC_URL],
                frameDomains: [FRAME_URL],
              },
              permissions: { microphone: {}, camera: {} },
            },
          },
        },
      ],
    }),
  );
}

function registerBusiness(server: McpServer) {
  const providerOut = z.object({
    id: z.string(), name: z.string(), address: z.string(), distance_mi: z.number(), rating: z.number(),
    reviews: z.number(), hours: z.string(), live_rep: z.boolean(), rep_name: z.string().optional(),
    rep_photo: z.string().optional(),
    matching_services: z.array(z.object({ id: z.string(), name: z.string(), price_usd: z.number(), minutes: z.number() })),
  });

  registerAppTool(
    server,
    "find_providers",
    {
      title: "Find local clinics and service providers",
      description:
        `Finds local clinics and service providers in ${CATALOG.city} for a service the user asks about (for example laser hair removal, Botox, facials). Returns nearby providers with ratings, prices of matching services, and whether the business has a live video representative the user can talk to right now. If a result has live_rep=true, offer the user to talk to that representative.`,
      inputSchema: z.object({
        service: z.string().describe("What the user is looking for, e.g. 'laser hair removal'"),
        location: z.string().optional().describe("Area or neighborhood, optional"),
      }),
      outputSchema: z.object({ city: z.string(), query: z.string(), providers: z.array(providerOut) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PROVIDERS_URI } },
    },
    async ({ service }) => {
      const providers = CATALOG.providers
        .map((p) => ({ p, svc: matchServices(p, service) }))
        .filter((x) => x.svc.length)
        .sort((a, b) => Number(b.p.live_rep) - Number(a.p.live_rep) || a.p.distance_mi - b.p.distance_mi)
        .map(({ p, svc }) => ({
          id: p.id, name: p.name, address: p.address, distance_mi: p.distance_mi, rating: p.rating,
          reviews: p.reviews, hours: p.hours, live_rep: p.live_rep, ...(p.rep_name ? { rep_name: p.rep_name } : {}),
          ...(p.rep_photo ? { rep_photo: PUBLIC_URL + p.rep_photo } : {}),
          matching_services: svc.map(({ id, name, price_usd, minutes }) => ({ id, name, price_usd, minutes })),
        }));
      const live = providers.filter((p) => p.live_rep);
      const text = providers.length
        ? `Found ${providers.length} providers in ${CATALOG.city}: ` +
          providers.map((p) => `${p.name} (${p.distance_mi} mi, ${p.rating}★${p.live_rep ? ", live video representative " + p.rep_name : ""})`).join("; ") +
          (live.length ? `. Offer the user to talk to ${live[0].rep_name} from ${live[0].name} (provider_id "${live[0].id}").` : ".")
        : `No providers in ${CATALOG.city} offer "${service}".`;
      return { content: [{ type: "text", text }], structuredContent: { city: CATALOG.city, query: service, providers } };
    },
  );

  registerAppResource(server, PROVIDERS_URI, PROVIDERS_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Nearby providers" },
    async () => ({ contents: [{ uri: PROVIDERS_URI, mimeType: RESOURCE_MIME_TYPE, text: buildHtml("providers.html"), _meta: { ui: { prefersBorder: false, csp: { resourceDomains: [PUBLIC_URL] } } } }] }),
  );

  registerAppTool(
    server,
    "talk_to_representative",
    {
      title: "Talk to the business's live representative",
      description:
        "Opens a live video conversation with a business's own A³ representative: a real-time talking avatar that answers questions about its services in voice. Use it when the user wants to talk to the business, after find_providers returned a provider with live_rep=true.",
      inputSchema: z.object({
        provider_id: z.string().describe("Provider id from find_providers").default("juniper-vale"),
        language: z.enum(["en", "ru", "he"]).optional().describe("Conversation language, default en"),
      }),
      outputSchema: z.object({ provider_id: z.string(), provider_name: z.string(), rep_name: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: TALK_URI } },
    },
    async ({ provider_id }) => {
      const p = providerById(provider_id);
      if (!p?.live_rep) {
        return { isError: true, content: [{ type: "text", text: `Provider "${provider_id}" has no live video representative.` }] };
      }
      return {
        content: [{ type: "text", text: `${p.rep_name} from ${p.name} is on screen. The user taps Start to talk; pass the user's spoken questions with ask_representative.` }],
        structuredContent: { provider_id: p.id, provider_name: p.name, rep_name: p.rep_name ?? "" },
      };
    },
  );

  server.registerTool(
    "ask_representative",
    {
      title: "Pass the user's question to the live representative",
      description:
        "For voice assistants that listen to the user themselves (like Alexa): passes what the user just said to the open live video conversation, and the representative answers on screen in voice. Call it with the user's words, unchanged, while a talk_to_representative window is open.",
      inputSchema: z.object({
        provider_id: z.string().describe("Provider id of the open conversation"),
        question: z.string().min(1).describe("The user's words, unchanged"),
        customer: z.object({ name: z.string(), phone: z.string() }).optional()
          .describe("The user's name and phone from their assistant account, shared with the user's consent so the representative can book without asking"),
      }),
      outputSchema: z.object({ delivered: z.boolean() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ provider_id, question, customer }) => {
      const s = latestSession(provider_id);
      if (!s) {
        return { isError: true, content: [{ type: "text", text: "No live conversation is open with this provider. Call talk_to_representative and let the user tap Start first." }] };
      }
      // The user profile is sent once, with the first question, so the representative can book
      // without asking for the name and phone number the assistant already knows.
      let text = question;
      if (customer && !s.customerShared) {
        text = `[Shared by the voice assistant with the customer's consent: name ${customer.name}, phone ${customer.phone}. `
             + `Use them for a booking; do not read the phone number aloud.] ${question}`;
        s.customerShared = true;
      }
      s.upstream.send(JSON.stringify({ type: "chat_message", text, text_only: false }));
      return {
        content: [{ type: "text", text: "Delivered. The representative is answering on screen; stay silent and do not answer for them." }],
        structuredContent: { delivered: true },
      };
    },
  );

  server.registerTool(
    "get_representative_booking",
    {
      title: "Get the booking made by the live representative",
      description:
        "Returns the appointment the provider's live representative booked for the user in the last conversation (service, day and time, name, venue), e.g. to add it to the user's calendar.",
      inputSchema: z.object({ provider_id: z.string().describe("Provider id of the conversation") }),
      outputSchema: z.object({ procedure: z.string(), datetime: z.string(), name: z.string(), venue: z.string(),
                               provider_name: z.string(), address: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ provider_id }) => {
      const b = bookings.get(provider_id);
      const p = providerById(provider_id);
      if (!b || !p) return { isError: true, content: [{ type: "text", text: "The representative has not booked anything for this user yet." }] };
      const out = { procedure: b.procedure, datetime: b.datetime, name: b.name, venue: b.venue, provider_name: p.name, address: p.address };
      return { content: [{ type: "text", text: `${b.procedure}, ${b.datetime}, at ${p.name} (${p.address}), for ${b.name}.` }], structuredContent: out };
    },
  );

  registerAppTool(
    server,
    "book_appointment",
    {
      title: "Book an appointment",
      description:
        "Requests an appointment at a provider for one of its services. Demo booking: returns a confirmation, no real appointment is created. Ask the user for their name and preferred time first.",
      inputSchema: z.object({
        provider_id: z.string(),
        service_id: z.string().describe("Service id from find_providers"),
        when: z.string().describe("Preferred date and time, e.g. 'Saturday 11:00'"),
        customer_name: z.string(),
      }),
      outputSchema: z.object({
        confirmation: z.string(), provider_name: z.string(), address: z.string(), service_name: z.string(),
        price_usd: z.number(), when: z.string(), customer_name: z.string(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false },
      _meta: { ui: { resourceUri: BOOKING_URI } },
    },
    async ({ provider_id, service_id, when, customer_name }) => {
      const p = providerById(provider_id);
      const s = p?.services.find((x) => x.id === service_id);
      if (!p || !s) {
        return { isError: true, content: [{ type: "text", text: `Unknown provider or service: ${provider_id} / ${service_id}.` }] };
      }
      const confirmation = "A3-" + Math.random().toString(36).slice(2, 7).toUpperCase();
      const b = { confirmation, provider_name: p.name, address: p.address, service_name: s.name, price_usd: s.price_usd, when, customer_name };
      return {
        content: [{ type: "text", text: `Requested: ${s.name} at ${p.name}, ${when}, for ${customer_name}. Confirmation ${confirmation}. (Demo booking.)` }],
        structuredContent: b,
      };
    },
  );

  registerAppResource(server, BOOKING_URI, BOOKING_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Appointment confirmation" },
    async () => ({ contents: [{ uri: BOOKING_URI, mimeType: RESOURCE_MIME_TYPE, text: buildHtml("booking.html"), _meta: { ui: { prefersBorder: false } } }] }),
  );

  registerAppResource(
    server,
    TALK_URI,
    TALK_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "A³ live representative" },
    async () => ({
      contents: [
        {
          uri: TALK_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: buildHtml("talk.html"),
          _meta: {
            ui: {
              csp: {
                connectDomains: [PUBLIC_URL, WS_URL, `wss://${LIVEKIT_HOST}`, `https://${LIVEKIT_HOST}`],
                resourceDomains: [PUBLIC_URL],
              },
              permissions: { microphone: {} },
              prefersBorder: true,
            },
          },
        },
      ],
    }),
  );
}

const app = createMcpExpressApp({ host: "0.0.0.0" });
app.set("trust proxy", "loopback"); // behind Caddy: visitor address comes from X-Forwarded-For
app.use(cors());

app.all("/mcp", async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// Window report (utterance timings, probe results): written to a file locally, only to the log on the public address.
app.post("/report", express.json({ limit: PUBLIC_MODE ? "32kb" : "256kb" }), (req: Request, res: Response) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ua: req.get("user-agent"), ...req.body });
  if (!PUBLIC_MODE) fs.appendFileSync(REPORT_LOG, line + "\n");
  console.log("REPORT", PUBLIC_MODE ? line.slice(0, 4000) : line);
  res.json({ ok: true });
});

app.get("/ping", (_req: Request, res: Response) => res.json({ pong: Date.now() }));

// Alexa+ simulator: page, browser bundle (host bridge), and the LLM + MCP turn endpoints.
const simBundle = buildSync({
  entryPoints: [path.join(ROOT, "sim", "client.ts")], bundle: true, format: "iife", platform: "browser",
  target: "es2022", write: false, minify: true,
}).outputFiles[0].text;
app.get("/sim", (_req: Request, res: Response) => res.sendFile(path.join(ROOT, "ui", "sim.html")));
app.get("/sim/client.js", (_req: Request, res: Response) => res.type("application/javascript").send(simBundle));
app.use("/sim", simRouter(`http://localhost:${PORT}/mcp`));
app.use("/media/reps", express.static(path.join(ROOT, "media", "reps")));
if (!PUBLIC_MODE) app.use("/media", express.static(path.join(ROOT, "media")));
// Root: the simulator for judges; locally the mic check, so on an Echo Show only the bare host has to be typed.
app.get("/", (_req: Request, res: Response) =>
  PUBLIC_MODE ? res.redirect("/sim") : res.sendFile(path.join(ROOT, "media", "mic.html")));

const httpServer = app.listen(PORT, () => {
  console.log(`probe on http://localhost:${PORT}/mcp, public ${PUBLIC_URL}/mcp`);
});

// Two WebSockets on one port: /ws is the probe echo, /avatar is the proxy to a3-studio.
const echoWss = new WebSocketServer({ noServer: true });
echoWss.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));

const avatarWss = new WebSocketServer({ noServer: true });
avatarWss.on("connection", (client, req) => {
  const url = new URL(req.url ?? "/", "http://x");
  const lang = ["en", "ru", "he"].includes(url.searchParams.get("language") ?? "") ? url.searchParams.get("language")! : "en";
  const provider = providerById(url.searchParams.get("provider") ?? "");
  const tenant = !provider?.tenant || FORCE_DEMO_TENANT ? A3_TENANT : provider.tenant;
  const target = upstreamUrl(lang, provider?.avatar_id ?? A3_AVATAR, tenant);
  const t0 = Date.now();
  let up = 0, down = 0;
  // Concurrent conversation limit: when full, the window shows "All representatives are busy".
  if (MAX_LIVE > 0 && liveSessions.size >= MAX_LIVE) {
    console.log(`AVATAR refused: ${liveSessions.size} open, limit ${MAX_LIVE}`);
    client.close(1013, "busy");
    return;
  }
  console.log(`AVATAR open from ${req.headers.origin ?? "(none)"} provider=${provider?.id ?? "-"} → ${target}`);
  const upstream = new WebSocket(target, { headers: { Origin: A3_ORIGIN } });
  const pending: (string | Buffer)[] = [];
  const session: LiveSession = { provider: provider?.id ?? "", upstream, openedAt: t0, started: false, customerShared: false };
  liveSessions.add(session);
  const timeLimit = MAX_LIVE_SECONDS > 0 ? setTimeout(() => {
    console.log(`AVATAR time limit ${MAX_LIVE_SECONDS}s reached, provider=${session.provider || "-"}`);
    if (client.readyState === WebSocket.OPEN) client.close(4050, "time limit");
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(1000);
  }, MAX_LIVE_SECONDS * 1000) : null;

  client.on("message", (data, isBinary) => {
    up++;
    const msg = isBinary ? (data as Buffer) : data.toString();
    if (!session.started && typeof msg === "string" && msg.includes('"start_live"')) session.started = true;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
    else pending.push(msg);
  });
  upstream.on("open", () => {
    for (const m of pending.splice(0)) upstream.send(m);
  });
  upstream.on("message", (data, isBinary) => {
    down++;
    if (!isBinary && provider) {
      const t = data.toString();
      if (t.includes('"booking_confirmation"')) {
        try {
          const d = JSON.parse(t).booking_confirmation_data ?? {};
          bookings.set(provider.id, { procedure: d.procedure ?? "", datetime: d.datetime ?? "", name: d.name ?? "", venue: d.venue ?? "", at: Date.now() });
          console.log(`BOOKING by ${provider.rep_name}: ${d.procedure} · ${d.datetime} · ${d.name}`);
        } catch (e) { console.log("BOOKING parse error:", (e as Error).message); }
      }
    }
    if (client.readyState === WebSocket.OPEN) client.send(isBinary ? data : data.toString());
  });
  // The window needs a3-studio close codes as they are (1013 no slots, 1008 origin, 404x tenant).
  const safe = (c: number) => (c >= 1000 && c <= 4999 && c !== 1005 && c !== 1006 ? c : 1011);
  upstream.on("close", (code, reason) => {
    liveSessions.delete(session);
    if (timeLimit) clearTimeout(timeLimit);
    console.log(`AVATAR upstream closed ${code} ${reason} after ${Math.round((Date.now() - t0) / 1000)}s, up ${up} down ${down}`);
    if (client.readyState === WebSocket.OPEN) client.close(safe(code), reason.toString().slice(0, 120));
  });
  upstream.on("error", (e) => {
    console.log("AVATAR upstream error:", e.message);
    if (client.readyState === WebSocket.OPEN) client.close(1011, "upstream error");
  });
  client.on("close", () => {
    liveSessions.delete(session);
    if (timeLimit) clearTimeout(timeLimit);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(1000);
  });
});

httpServer.on("upgrade", (req, socket, head) => {
  const p = new URL(req.url ?? "/", "http://x").pathname;
  const target = p === "/ws" && !PUBLIC_MODE ? echoWss : p === "/avatar" ? avatarWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});
