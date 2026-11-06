// Daniel's private Alexa skill: "Alexa, ask Jarvis to ...". Checks Amazon signed the request, hands the words to Jarvis, speaks the answer.
// Only this Worker holds ALEXA_TOKEN, and Jarvis accepts that token on /api/alexa alone.
// Also /siri, for Daniel's "Ask Jarvis" Siri Shortcut: it needs SIRI_TOKEN as a Bearer token, which Jarvis also checks, on /api/siri alone.
import { Rejected, verifyRequest } from "./verify.js";
import { OPENER_BY_INTENT } from "./phrases.js";

const JARVIS_URL = "http://192.168.8.150:8770/api/alexa";
const JARVIS_MS = 7300;  // Jarvis gives up at 6.5 s; Alexa stops waiting at about 8
const MAX_BODY = 128 * 1024;
const VOICE_URL = "http://192.168.8.150:8770/api/alexa/voice";
const AUDIO_URL = "http://192.168.8.150:8770/api/alexa/audio/";
const VOICE_MS = 1800;  // for the Worker's own phrases; cached after the first time, so usually far quicker
const SIRI_URL = "http://192.168.8.150:8770/api/siri";
const SIRI_MS = 30000;  // Siri waits much longer than Alexa; Jarvis gives up at 25 s and sends anything slower to his phone

const same = (a, b) => {  // constant time, so the token can't be guessed a letter at a time
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
};

export async function siri(request, env) {
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.SIRI_TOKEN || !given || !same(given, env.SIRI_TOKEN)) return json({ text: "Not allowed." }, 401);
  const raw = await request.text();
  if (raw.length > 4096) return json({ text: "That's too long, sir." }, 413);
  let text = "";
  try { text = String(JSON.parse(raw).text || "").trim().slice(0, 500); } catch { return json({ text: "I didn't catch that, sir." }, 400); }
  if (!text) return json({ text: "I didn't catch that, sir." });
  try {
    const response = await env.VPC_JARVIS.fetch(new Request(SIRI_URL, {
      method: "POST", headers: { "x-siri-token": env.SIRI_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(SIRI_MS)
    }));
    if (!response.ok) throw new Error("HTTP " + response.status);
    const reply = await response.json();
    return json({ text: reply.text || "Done, sir." });
  } catch (error) {
    console.log("siri: " + error.message);
    return json({ text: "I can't reach Jarvis at the moment, sir." });
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json;charset=UTF-8", "cache-control": "no-store" } });

// Jarvis's own voice when there's a clip for it (an MP3 this Worker serves at /audio/), otherwise Alexa reads the text in hers.
const CLIP = /^a[0-9a-f]{39}$/;
const said = (text, clip, origin) => clip && origin && CLIP.test(clip)
  ? { type: "SSML", ssml: `<speak><audio src="${origin}/audio/${clip}.mp3"/></speak>` }
  : { type: "PlainText", text: String(text).slice(0, 7000) };

export const speak = (text, keepOpen = false, voice = {}) => json({
  version: "1.0",
  response: {
    outputSpeech: said(text, voice.audio, voice.origin),
    ...(keepOpen ? { reprompt: { outputSpeech: said("Yes, sir?", voice.reprompt, voice.origin) } } : {}),
    shouldEndSession: !keepOpen
  }
});

async function voiceOf(env, text) {
  try {
    const response = await env.VPC_JARVIS.fetch(new Request(VOICE_URL, {
      method: "POST", headers: { "x-alexa-token": env.ALEXA_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(VOICE_MS)
    }));
    return response.ok ? (await response.json()).audio || null : null;
  } catch {
    return null;
  }
}

// One of the Worker's own phrases, in Jarvis's voice if he's there to make it
async function say(env, origin, text, keepOpen = false) {
  if (!origin) return speak(text, keepOpen);
  const [audio, reprompt] = await Promise.all([voiceOf(env, text), keepOpen ? voiceOf(env, "Yes, sir?") : null]);
  return speak(text, keepOpen, { audio, reprompt, origin });
}

export async function audio(path, env) {
  const clip = path.slice("/audio/".length).replace(/\.mp3$/, "");
  if (!CLIP.test(clip)) return new Response("Not found.", { status: 404 });
  try {
    const response = await env.VPC_JARVIS.fetch(new Request(AUDIO_URL + clip, { headers: { "x-alexa-token": env.ALEXA_TOKEN }, signal: AbortSignal.timeout(5000) }));
    if (!response.ok) return new Response("Not found.", { status: 404 });
    return new Response(response.body, { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" } });
  } catch (error) {
    console.log("audio: " + error.message);
    return new Response("Not found.", { status: 404 });
  }
}

// What he said, as Jarvis should hear it. null if it isn't something to send on.
export function wordsFrom(request) {
  const intent = request?.intent?.name;
  if (intent === "AMAZON.YesIntent") return "yes";
  if (intent === "AMAZON.NoIntent") return "no";
  let words = null;
  if (intent === "AnswerIntent") words = request.intent.slots?.answer?.value?.trim();
  else if (intent in OPENER_BY_INTENT) {
    const said = request.intent.slots?.text?.value?.trim();
    if (said) words = `${OPENER_BY_INTENT[intent]} ${said}`.trim();
  }
  // "ask Jarvis to ..." said while the skill's already listening
  return words ? words.replace(/^(?:(?:please )?(?:ask|tell) )?jarvis(?: to)?\s+/i, "").replace(/^to\s+/i, "") || null : null;
}

async function askJarvis(env, text, device) {
  try {
    const response = await env.VPC_JARVIS.fetch(new Request(JARVIS_URL, {
      method: "POST",
      headers: { "x-alexa-token": env.ALEXA_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ text, device }),
      signal: AbortSignal.timeout(JARVIS_MS)
    }));
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } catch (error) {
    console.log("jarvis: " + error.message);
    return { text: "I can't reach Jarvis at the moment, sir. Do try the page.", keep_open: false };
  }
}

export async function handle(body, env, origin = "") {
  const request = body.request;
  if (request.type === "LaunchRequest") return say(env, origin, "Yes, sir?", true);
  if (request.type === "SessionEndedRequest") return json({ version: "1.0", response: {} });
  if (request.type !== "IntentRequest") return speak("I didn't catch that, sir.");
  const intent = request.intent?.name;
  if (intent === "AMAZON.StopIntent" || intent === "AMAZON.CancelIntent" || intent === "AMAZON.NavigateHomeIntent") return say(env, origin, "Very good, sir.");
  if (intent === "AMAZON.HelpIntent") return say(env, origin, "Tell me what you'd like, sir. For example, turn off the living room lights, or what time is the next race.", true);
  const text = wordsFrom(request);
  if (!text) console.log(`no words from ${intent}, slots: ${Object.keys(request.intent?.slots || {}).join() || "none"}`);
  if (!text) return say(env, origin, "I didn't catch that, sir. I'm listening, so there's no need to say my name. Just start with a word like what, turn or play.", true);
  const reply = await askJarvis(env, text, body.context?.System?.device?.deviceId);
  if (!reply.text) return json({ version: "1.0", response: { shouldEndSession: true } });  // it worked, so nothing to say (Daniel's choice)
  return speak(reply.text, reply.keep_open === true, { audio: reply.audio, reprompt: reply.reprompt_audio, origin });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.startsWith("/audio/")) return audio(url.pathname, env);
    if (request.method !== "POST") return new Response("Not found.", { status: 404 });
    if (url.pathname === "/siri") return siri(request, env);
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY) return new Response("Too large.", { status: 413 });
    let body;
    try {
      body = await verifyRequest({ certUrl: request.headers.get("signaturecertchainurl"), signature: request.headers.get("signature-256"), rawBody, skillId: env.ALEXA_SKILL_ID });
    } catch (error) {
      console.log("refused: " + error.message);
      return new Response("Bad request.", { status: 400 });  // what Amazon asks for, whatever the reason
    }
    return handle(body, env, url.origin);
  }
};
