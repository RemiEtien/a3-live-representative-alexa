/**
 * Alexa+ simulator, server side. Real Alexa+ add-ons are partner-only, so the demo
 * plays Alexa with an LLM that reaches the business ONLY through our MCP server,
 * over real MCP (Streamable HTTP), exactly as an Alexa+ add-on would be called.
 *
 * Model key: a separate research key, never the A³ production key.
 */
import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import express, { type Request, type Response, type Router } from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROD_KEY_TAIL = "V_-A"; // A³ production key: the simulator must never spend it
const MODEL = process.env.SIM_MODEL ?? "gemini-flash-latest";

const SYSTEM = () => `You are Alexa, Amazon's voice assistant, running on an Echo Show with a screen.
Speak briefly: one or two short sentences per turn, natural spoken English, no lists, no markdown.
Local businesses reach you through tools. When the user looks for a service, call find_providers.
Summarize the best match in one sentence. If a provider has live_rep=true, say that it has a live
video representative and ask whether the user wants to talk to them now.
When the user agrees, call talk_to_representative with that provider_id and then say only a short
line such as "Connecting you with Hannah now." From then on the representative answers the user;
do not answer questions about the clinic yourself.
The signed-in user of this Echo Show is ${USER.name}; their phone is ${USER.phone}. You already know this from
the account: never ask for their name or phone.
When a live representative is on screen, the representative books the appointment, not you.
If the user asks to add an appointment to their calendar, call get_representative_booking for that provider,
then add_to_calendar with its details, then say one short line that it is on their calendar.
Only if a provider has no live representative and the user wants to book, call book_appointment yourself
with the user's name.`;

/** Account owner profile: real Alexa knows it on its own; in the simulator it is defined here. */
export const USER = { name: "Chris Miller", phone: "+1 512 555 0142" };

/** Alexa's own calendar: not a business MCP server but a built-in assistant capability. */
const CALENDAR_DECL: FunctionDeclaration = {
  name: "add_to_calendar",
  description: "Adds an event to the user's own Alexa calendar.",
  parametersJsonSchema: { type: "object", properties: {
    title: { type: "string" }, when: { type: "string", description: "Day and time as agreed" },
    location: { type: "string" } }, required: ["title", "when"] },
};

// Keys come from the environment (GEMINI_API_KEY, ELEVENLABS_API_KEY). For local runs the Gemini key
// may instead be read from an existing env file named by KEYS_ENV_FILE, and the ElevenLabs key from
// ~/.secrets/elevenlabs_api_key.txt, so keys never have to be copied into this folder.
function researchKey(): string {
  let key = process.env.GEMINI_API_KEY?.trim() ?? "";
  if (!key && process.env.KEYS_ENV_FILE) {
    const env = fs.readFileSync(process.env.KEYS_ENV_FILE, "utf8");
    key = env.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, "") ?? "";
  }
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  if (key.endsWith(PROD_KEY_TAIL)) throw new Error("refusing to run the simulator on the A³ production key");
  return key;
}

function elevenLabsKey(): string {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  try { return fs.readFileSync(path.join(os.homedir(), ".secrets", "elevenlabs_api_key.txt"), "utf8").trim(); } catch { return ""; }
}

// Limits for the public address: per IP per minute and overall per day (model and voice credits).
// 0 = no limit (local).
const LIMITS = {
  turnsPerMin: parseInt(process.env.SIM_TURNS_PER_MIN ?? "0", 10),
  turnsPerDay: parseInt(process.env.SIM_TURNS_PER_DAY ?? "0", 10),
  ttsPerMin: parseInt(process.env.SIM_TTS_PER_MIN ?? "0", 10),
  ttsCharsPerDay: parseInt(process.env.SIM_TTS_CHARS_PER_DAY ?? "0", 10),
};
const perIp = new Map<string, number[]>();
const daily = { day: "", turns: 0, ttsChars: 0 };
function today() {
  const d = new Date().toISOString().slice(0, 10);
  if (daily.day !== d) Object.assign(daily, { day: d, turns: 0, ttsChars: 0 });
  return daily;
}
/** true if the address has already made `limit` requests of this kind in the last minute. */
function overMinute(kind: string, ip: string, limit: number): boolean {
  if (limit <= 0) return false;
  const key = kind + " " + ip, now = Date.now();
  const hits = (perIp.get(key) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= limit) { perIp.set(key, hits); return true; }
  hits.push(now); perIp.set(key, hits);
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of perIp) if (!v.some((t) => now - t < 60_000)) perIp.delete(k); }, 300_000).unref();

async function mcpClient(mcpUrl: string): Promise<Client> {
  const c = new Client({ name: "Alexa+ simulator", version: "0.1.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  return c;
}

type UiItem = { tool: string; uri: string; input: Record<string, unknown>; result: unknown; native?: boolean };

export function simRouter(mcpUrl: string): Router {
  const r = express.Router();
  const ai = new GoogleGenAI({ apiKey: researchKey() });
  let toolsCache: { decls: FunctionDeclaration[]; ui: Map<string, string> } | null = null;

  async function tools(c: Client) {
    if (toolsCache) return toolsCache;
    const { tools } = await c.listTools();
    const shown = tools.filter((t) => t.name !== "a3_window_probe" && t.name !== "ask_representative");
    toolsCache = {
      decls: shown.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })),
      ui: new Map(tools.filter((t) => t._meta?.ui?.resourceUri).map((t) => [t.name, t._meta!.ui!.resourceUri as string])),
    };
    return toolsCache;
  }

  // One user turn: model ↔ MCP tools until the model speaks.
  r.post("/turn", express.json({ limit: "512kb" }), async (req: Request, res: Response) => {
    const t0 = Date.now();
    const history: Content[] = Array.isArray(req.body?.history) ? req.body.history : [];
    const text = String(req.body?.text ?? "").trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: "empty" });
    const d = today();
    if (overMinute("turn", req.ip ?? "", LIMITS.turnsPerMin) || (LIMITS.turnsPerDay > 0 && d.turns >= LIMITS.turnsPerDay)) {
      console.log(`SIM turn limited ip=${req.ip} day=${d.turns}`);
      return res.status(429).json({ error: "limited", say: "The demo is busy right now. Please try again in a minute." });
    }
    d.turns++;
    const c = await mcpClient(mcpUrl);
    try {
      const { decls, ui } = await tools(c);
      const contents: Content[] = [...history, { role: "user", parts: [{ text }] }];
      const uis: UiItem[] = [];
      const calls: { name: string; ms: number }[] = [];
      let say = "";
      for (let round = 0; round < 4; round++) {
        const resp = await ai.models.generateContent({
          model: MODEL, contents,
          config: { systemInstruction: SYSTEM(), tools: [{ functionDeclarations: [...decls, CALENDAR_DECL] }], thinkingConfig: { thinkingBudget: 0 } },
        });
        const parts = resp.candidates?.[0]?.content?.parts ?? [];
        contents.push({ role: "model", parts });
        const fcs = parts.filter((p) => p.functionCall);
        if (!fcs.length) { say = parts.map((p) => p.text ?? "").join("").trim(); break; }
        const replies = [];
        for (const p of fcs) {
          const fc = p.functionCall!;
          const tc = Date.now();
          if (fc.name === "add_to_calendar") {
            // Alexa's built-in calendar: show a card on screen; nothing is sent to the business
            calls.push({ name: "add_to_calendar (Alexa)", ms: 0 });
            uis.push({ tool: "add_to_calendar", uri: "", input: (fc.args ?? {}) as Record<string, unknown>, result: null, native: true });
            replies.push({ functionResponse: { id: fc.id, name: fc.name, response: { result: "Added to the user's calendar." } } });
            continue;
          }
          const out = await c.callTool({ name: fc.name!, arguments: (fc.args ?? {}) as Record<string, unknown> });
          calls.push({ name: fc.name!, ms: Date.now() - tc });
          const uri = ui.get(fc.name!);
          if (uri && !out.isError) uis.push({ tool: fc.name!, uri, input: (fc.args ?? {}) as Record<string, unknown>, result: out });
          const textOut = (out.content as { type: string; text?: string }[] | undefined)?.map((x) => x.text ?? "").join(" ") ?? "";
          replies.push({ functionResponse: { id: fc.id, name: fc.name, response: { result: textOut, error: out.isError ? true : undefined, structured: out.structuredContent } } });
        }
        contents.push({ role: "user", parts: replies });
      }
      res.json({ say, uis, calls, history: contents, ms: Date.now() - t0 });
    } catch (e) {
      console.error("SIM turn error:", e);
      res.status(500).json({ error: String((e as Error).message ?? e) });
    } finally {
      c.close().catch(() => {});
    }
  });

  // Alexa's voice: ElevenLabs (grant credits) streamed as mp3. A stock US voice, not a copy of Amazon's.
  const elevenKey = elevenLabsKey();
  const VOICE = process.env.SIM_VOICE ?? "cgSgspJ2msm6clMCkdW9";
  r.get("/tts", async (req: Request, res: Response) => {
    const text = String(req.query.text ?? "").slice(0, 600);
    if (!elevenKey || !text) return res.status(503).end();
    // Over the limit we return 429: the page falls back to the browser voice by itself.
    const d = today();
    if (overMinute("tts", req.ip ?? "", LIMITS.ttsPerMin) || (LIMITS.ttsCharsPerDay > 0 && d.ttsChars + text.length > LIMITS.ttsCharsPerDay)) {
      console.log(`SIM tts limited ip=${req.ip} dayChars=${d.ttsChars}`);
      return res.status(429).end();
    }
    d.ttsChars += text.length;
    try {
      const up = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=mp3_44100_128&optimize_streaming_latency=2`, {
        method: "POST",
        headers: { "xi-api-key": elevenKey, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: "eleven_flash_v2_5", voice_settings: { stability: 0.5, similarity_boost: 0.8, speed: 1.05 } }),
      });
      if (!up.ok || !up.body) { console.error("SIM tts", up.status, await up.text().catch(() => "")); return res.status(502).end(); }
      res.type("audio/mpeg");
      const reader = up.body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
      res.end();
    } catch (e) {
      console.error("SIM tts error:", e);
      if (!res.headersSent) res.status(502).end();
    }
  });

  // Account owner profile for the page: a single source, the same one used in the Alexa prompt.
  r.get("/user", (_req: Request, res: Response) => res.json(USER));

  // UI resource HTML for the host iframe.
  r.get("/resource", async (req: Request, res: Response) => {
    const c = await mcpClient(mcpUrl);
    try {
      const out = await c.readResource({ uri: String(req.query.uri) });
      const item = out.contents[0] as { text?: string; _meta?: unknown };
      res.json({ html: item.text ?? "", meta: item._meta ?? {} });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message ?? e) });
    } finally {
      c.close().catch(() => {});
    }
  });

  // Direct MCP tool call from the simulator: the user's speech while a representative is on screen.
  r.post("/call", express.json(), async (req: Request, res: Response) => {
    if (overMinute("call", req.ip ?? "", LIMITS.turnsPerMin)) return res.status(429).json({ isError: true, error: "limited" });
    const c = await mcpClient(mcpUrl);
    try {
      const t0 = Date.now();
      const out = await c.callTool({ name: String(req.body?.name), arguments: req.body?.arguments ?? {} });
      res.json({ ...out, ms: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message ?? e) });
    } finally {
      c.close().catch(() => {});
    }
  });

  return r;
}
