import assert from "node:assert/strict";
import { test } from "node:test";
import { handle, siri, wordsFrom } from "../src/index.js";

const said = (name, value) => ({ type: "IntentRequest", intent: { name, slots: { text: { value }, answer: { value } } } });

test("the opening word is put back", () => {
  assert.equal(wordsFrom(said("Say_what", "time is f1 practice")), "what time is f1 practice");
  assert.equal(wordsFrom(said("Say_whats", "the weather")), "what's the weather");
  assert.equal(wordsFrom(said("Say_to", "turn off the lights")), "turn off the lights");
  assert.equal(wordsFrom(said("Say_turn", "off the lights")), "turn off the lights");
  assert.equal(wordsFrom(said("AnswerIntent", "the living room")), "the living room");
  assert.equal(wordsFrom({ type: "IntentRequest", intent: { name: "AMAZON.YesIntent" } }), "yes");
  assert.equal(wordsFrom({ type: "IntentRequest", intent: { name: "AMAZON.FallbackIntent" } }), null);
  assert.equal(wordsFrom(said("AnswerIntent", "ask jarvis to turn down the living room tv")), "turn down the living room tv");
  assert.equal(wordsFrom(said("AnswerIntent", "ask jarvis what's the weather")), "what's the weather");
  assert.equal(wordsFrom(said("AnswerIntent", "jarvis pause it")), "pause it");
  assert.equal(wordsFrom(said("AnswerIntent", "to turn the lights off")), "turn the lights off");
  assert.equal(wordsFrom(said("AnswerIntent", "jarvisworld rocks")), "jarvisworld rocks");
});

const envReplying = (reply, seen = []) => ({ ALEXA_TOKEN: "t", VPC_JARVIS: { fetch: async r => { seen.push([r.headers.get("x-alexa-token"), await r.json()]); return Response.json(reply); } } });
const read = async r => (await r.json()).response;

test("a reply is spoken, and a question keeps the Echo listening", async () => {
  const seen = [];
  let out = await read(await handle({ request: said("Say_turn", "off the lights") }, envReplying({ text: "Done, sir." }, seen), () => {}));
  assert.equal(out.outputSpeech.text, "Done, sir.");
  assert.equal(out.shouldEndSession, true);
  assert.deepEqual(seen[0], ["t", { text: "turn off the lights" }]);
  seen.length = 0;
  await handle({ request: said("Say_this", "is the living room"), context: { System: { device: { deviceId: "dot-1" } } } }, envReplying({ text: "Very good." }, seen));
  assert.deepEqual(seen[0], ["t", { text: "this is the living room", device: "dot-1" }]);
  out = await read(await handle({ request: said("Say_turn", "the lights down") }, envReplying({ text: "Which room, sir?", keep_open: true }), () => {}));
  assert.equal(out.shouldEndSession, false);
});

test("nothing to say means silence, not a filler", async () => {
  const out = await read(await handle({ request: said("Say_turn", "off the lights") }, envReplying({ text: "", keep_open: false })));
  assert.equal(out.outputSpeech, undefined);
  assert.equal(out.shouldEndSession, true);
});

test("Jarvis being down is said plainly", async () => {
  const env = { ALEXA_TOKEN: "t", VPC_JARVIS: { fetch: async () => { throw new Error("down"); } } };
  assert.match((await read(await handle({ request: said("Say_what", "time is it") }, env, () => {}))).outputSpeech.text, /can't reach Jarvis/);
});

test("stop ends without troubling Jarvis, and opening just listens", async () => {
  const env = { VPC_JARVIS: { fetch: async () => assert.fail("shouldn't call") } };
  assert.equal((await read(await handle({ request: { type: "IntentRequest", intent: { name: "AMAZON.StopIntent" } } }, env, () => {}))).shouldEndSession, true);
  assert.equal((await read(await handle({ request: { type: "LaunchRequest" } }, env, () => {}))).shouldEndSession, false);
});


test("siri needs its own token and gets a reply to speak", async () => {
  const seen = [];
  const env = { SIRI_TOKEN: "s", VPC_JARVIS: { fetch: async r => { seen.push([r.url, r.headers.get("x-siri-token"), await r.json()]); return new Response(JSON.stringify({ text: "" })); } } };
  const ask = (auth, body = { text: "turn off the lights" }) => siri(new Request("https://x/siri", { method: "POST", headers: auth ? { authorization: auth } : {}, body: JSON.stringify(body) }), env);
  assert.equal((await ask("Bearer wrong")).status, 401);
  assert.equal((await ask(null)).status, 401);
  assert.equal(seen.length, 0);
  const ok = await ask("Bearer s");
  assert.deepEqual(await ok.json(), { text: "Done, sir." });  // a quiet success still says something on Siri
  assert.deepEqual(seen[0], ["http://192.168.8.150:8770/api/siri", "s", { text: "turn off the lights" }]);
  assert.equal((await siri(new Request("https://x/siri", { method: "POST", headers: { authorization: "Bearer s" } }), { ...env, SIRI_TOKEN: "" })).status, 401);
});
