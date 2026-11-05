// Daniel's private Alexa skill: "Alexa, ask Jarvis to ...". Checks Amazon signed the request, hands the words to Jarvis, speaks the answer.
// Only this Worker holds ALEXA_TOKEN, and Jarvis accepts that token on /api/alexa alone.
import { Rejected, verifyRequest } from "./verify.js";
import { OPENER_BY_INTENT } from "./phrases.js";

const JARVIS_URL = "http://192.168.8.150:8770/api/alexa";
const JARVIS_MS = 7300;  // Jarvis gives up at 6.5 s; Alexa stops waiting at about 8
const HOLDING_MS = 2500;
const MAX_BODY = 128 * 1024;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json;charset=UTF-8", "cache-control": "no-store" } });

export const speak = (text, keepOpen = false) => json({
  version: "1.0",
  response: {
    outputSpeech: { type: "PlainText", text: String(text).slice(0, 7000) },
    ...(keepOpen ? { reprompt: { outputSpeech: { type: "PlainText", text: "Yes, sir?" } } } : {}),
    shouldEndSession: !keepOpen
  }
});

// What he said, as Jarvis should hear it. null if it isn't something to send on.
export function wordsFrom(request) {
  const intent = request?.intent?.name;
  if (intent === "AMAZON.YesIntent") return "yes";
  if (intent === "AMAZON.NoIntent") return "no";
  if (intent === "AnswerIntent") return request.intent.slots?.answer?.value?.trim() || null;
  if (intent in OPENER_BY_INTENT) {
    const said = request.intent.slots?.text?.value?.trim();
    return said ? `${OPENER_BY_INTENT[intent]} ${said}`.trim() : null;
  }
  return null;
}

async function holdingLine(body) {
  const system = body?.context?.System;
  if (!system?.apiEndpoint?.startsWith("https://") || !system.apiAccessToken) return;
  await fetch(`${system.apiEndpoint}/v1/directives`, {
    method: "POST",
    headers: { authorization: `Bearer ${system.apiAccessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ header: { requestId: body.request.requestId }, directive: { type: "VoicePlayer.Speak", speech: "One moment, sir." } })
  }).catch(() => {});
}

async function askJarvis(env, text, waitUntil, body) {
  const holding = setTimeout(() => waitUntil(holdingLine(body)), HOLDING_MS);
  try {
    const response = await env.VPC_JARVIS.fetch(new Request(JARVIS_URL, {
      method: "POST",
      headers: { "x-alexa-token": env.ALEXA_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(JARVIS_MS)
    }));
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } catch (error) {
    console.log("jarvis: " + error.message);
    return { text: "I can't reach Jarvis at the moment, sir. Do try the page.", keep_open: false };
  } finally {
    clearTimeout(holding);
  }
}

export async function handle(body, env, waitUntil) {
  const request = body.request;
  if (request.type === "LaunchRequest") return speak("Yes, sir?", true);
  if (request.type === "SessionEndedRequest") return json({ version: "1.0", response: {} });
  if (request.type !== "IntentRequest") return speak("I didn't catch that, sir.");
  const intent = request.intent?.name;
  if (intent === "AMAZON.StopIntent" || intent === "AMAZON.CancelIntent" || intent === "AMAZON.NavigateHomeIntent") return speak("Very good, sir.");
  if (intent === "AMAZON.HelpIntent") return speak("Tell me what you'd like, sir. For example, turn off the living room lights, or what time is the next race.", true);
  const text = wordsFrom(request);
  if (!text) return speak("I didn't catch that, sir. Say it starting with a word like what, turn or play.", true);
  const reply = await askJarvis(env, text, waitUntil, body);
  return speak(reply.text || "Done, sir.", reply.keep_open === true);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Not found.", { status: 404 });
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY) return new Response("Too large.", { status: 413 });
    let body;
    try {
      body = await verifyRequest({ certUrl: request.headers.get("signaturecertchainurl"), signature: request.headers.get("signature-256"), rawBody, skillId: env.ALEXA_SKILL_ID });
    } catch (error) {
      console.log("refused: " + error.message);
      return new Response("Bad request.", { status: 400 });  // what Amazon asks for, whatever the reason
    }
    return handle(body, env, promise => ctx.waitUntil(promise));
  }
};
