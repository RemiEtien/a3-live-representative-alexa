// Alexa+ simulator, browser side: push-to-talk speech → /sim/turn (LLM + MCP tools),
// spoken reply, and MCP Apps views of the tool results rendered through the official host bridge.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

type UiItem = { tool: string; uri: string; input: Record<string, unknown>; result: any; native?: boolean };
const $ = (id: string) => document.getElementById(id)!;
let history: unknown[] = [];
let activeRep: { provider_id: string; name: string } | null = null;
// Account owner: real Alexa knows them on its own and, with consent, passes the details to the representative for booking.
let user: { name: string; phone: string } | null = null;
fetch("/sim/user").then((r) => r.json()).then((u) => { user = u; }).catch(() => {});

// ---------- screen ----------
type State = "" | "listening" | "thinking" | "speaking";
function setState(s: State, label = "") {
  document.body.classList.remove("listening", "thinking", "speaking");
  if (s) document.body.classList.add(s);
  $("state").textContent = label;
}
function mcp(line: string) {
  const d = document.createElement("div");
  d.textContent = line;
  $("mcp").appendChild(d);
  while ($("mcp").children.length > 4) $("mcp").firstElementChild!.remove();
}
function tick() {
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const h = now.getHours();
  $("greet") && ($("greet").textContent = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening");
}
tick(); setInterval(tick, 15000);

// ---------- Alexa's voice: ElevenLabs via /sim/tts, the browser voice only as a fallback ----------
let voiceAudio: HTMLAudioElement | null = null;
function speak(text: string): Promise<void> {
  if (!text) return Promise.resolve();
  return new Promise((done) => {
    const a = new Audio("/sim/tts?text=" + encodeURIComponent(text));
    voiceAudio = a;
    const finish = () => { setState(""); done(); };
    a.onplaying = () => setState("speaking");
    a.onended = finish;
    a.onerror = () => speakBrowser(text).then(finish);
    a.play().catch(() => speakBrowser(text).then(finish));
  });
}
function speakBrowser(text: string): Promise<void> {
  return new Promise((done) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US"; u.rate = 1.03;
    const v = speechSynthesis.getVoices().find((x) => /Google US English|Samantha|Aria|Jenny/i.test(x.name));
    if (v) u.voice = v;
    u.onstart = () => setState("speaking");
    u.onend = () => done(); u.onerror = () => done();
    speechSynthesis.speak(u);
  });
}

// ---------- Alexa's own calendar card (not a business MCP view) ----------
function showCalendar(input: Record<string, unknown>) {
  const card = document.createElement("div");
  card.className = "view calendar";
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  card.innerHTML = `<div class="cal"><div class="cal-top"><span class="cal-ok">✓</span>Added to your calendar</div>
    <div class="cal-title">${esc(input.title)}</div><div class="cal-when">${esc(input.when)}</div>
    ${input.location ? `<div class="cal-where">${esc(input.location)}</div>` : ""}</div>`;
  $("stage").replaceChildren(card);
}

// ---------- MCP Apps views ----------
async function showView(item: UiItem) {
  if (item.native) { showCalendar(item.input); return; }
  const res = await fetch("/sim/resource?uri=" + encodeURIComponent(item.uri)).then((r) => r.json());
  const isRep = item.tool === "talk_to_representative";
  const wrap = document.createElement("div");
  wrap.className = "view";
  const frame = document.createElement("iframe");
  // No "microphone" on purpose: on an Echo Show Alexa owns the mic. Autoplay is delegated,
  // so the representative can start without a tap inside the view.
  frame.setAttribute("allow", "autoplay");
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
  frame.srcdoc = res.html;
  wrap.appendChild(frame);
  $("stage").replaceChildren(wrap);
  const bridge = new AppBridge(null, { name: "Alexa+ simulator", version: "0.1.0" }, { serverTools: {}, logging: {} });
  bridge.oncalltool = async (params: any) =>
    fetch("/sim/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: params.name, arguments: params.arguments }) }).then((r) => r.json());
  bridge.oninitialized = () => {
    bridge.sendToolInput({ arguments: isRep ? { ...item.input, autostart: true } : item.input });
    bridge.sendToolResult(item.result);
  };
  frame.addEventListener("load", async () => {
    await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  }, { once: true });
  if (isRep) {
    const s = item.result?.structuredContent;
    activeRep = { provider_id: s?.provider_id ?? String(item.input.provider_id), name: s?.rep_name ?? "the representative" };
    document.body.classList.add("rep");
  }
}

function endRep() {
  activeRep = null;
  document.body.classList.remove("rep");
  $("stage").replaceChildren();
}

// ---------- one turn ----------
async function handle(text: string) {
  $("you").textContent = text;
  // "Thanks, goodbye" also ends the conversation: people say goodbye politely, not in a single word
  if (/^(alexa[, ]+)?(thanks?( you)?[, ]+)?(stop|goodbye|bye|end( the)? (call|conversation)|hang up)\b/i.test(text) && activeRep) {
    endRep(); $("say").textContent = "Okay, I ended the conversation.";
    await speak("Okay, I ended the conversation."); return;
  }
  if (activeRep) {
    // Alexa listens; the representative answers on screen. The words go through the MCP tool.
    const r = await fetch("/sim/call", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ask_representative", arguments: { provider_id: activeRep.provider_id, question: text, ...(user ? { customer: user } : {}) } }) }).then((x) => x.json());
    mcp(`ask_representative → ${r.isError ? "not delivered" : "delivered"} · ${r.ms} ms`);
    setState("", `Talking to ${activeRep.name} · Space to speak · Esc to end`);
    return;
  }
  $("say").textContent = "";
  setState("thinking");
  const r = await fetch("/sim/turn", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ history, text }) }).then((x) => x.json());
  if (r.error) { setState(""); $("say").textContent = r.say || "Sorry, something went wrong."; return; }
  history = r.history;
  for (const c of r.calls ?? []) mcp(`${c.name} · ${c.ms} ms`);
  for (const u of r.uis ?? []) await showView(u);
  $("say").textContent = r.say || "";
  await speak(r.say);
  if (activeRep) setState("", `Talking to ${activeRep.name} · press Space to speak`);
  // Like Alexa's follow-up mode: after a question the mic reopens by itself.
  else if (/\?\s*$/.test(r.say ?? "")) listen();
}

// ---------- push-to-talk ----------
const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
let rec: any = null;
function listen() {
  if (!SR) { $("say").textContent = "Speech recognition is not available in this browser. Type instead."; return; }
  speechSynthesis.cancel();
  if (voiceAudio) { voiceAudio.pause(); voiceAudio = null; }
  rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; rec.maxAlternatives = 1;
  let final = "";
  setState("listening", "Listening…");
  rec.onresult = (e: any) => {
    final = Array.from(e.results as ArrayLike<any>).map((x: any) => x[0].transcript).join(" ");
    $("you").textContent = final;
  };
  rec.onend = () => {
    setState(activeRep ? "" : "", activeRep ? `Talking to ${activeRep.name} · press Space to speak` : "");
    if (final.trim()) handle(final.trim());
  };
  rec.onerror = (e: any) => { if (e.error !== "no-speech" && e.error !== "aborted") $("state").textContent = "mic: " + e.error; };
  rec.start();
}
$("talk").addEventListener("click", () => (rec && document.body.classList.contains("listening") ? rec.stop() : listen()));
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); $("talk").click(); }
  // Esc ends the representative call at once: removing the view closes its WebSocket and the A³ slot.
  if (e.code === "Escape" && activeRep) { endRep(); setState("", ""); $("say").textContent = "Conversation ended."; }
});
$("typed").addEventListener("keydown", (e) => {
  const el = e.target as HTMLInputElement;
  if (e.key === "Enter" && el.value.trim()) { handle(el.value.trim()); el.value = ""; el.blur(); }
});
speechSynthesis.getVoices();
