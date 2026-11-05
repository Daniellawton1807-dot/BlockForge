// A sentence reaches a skill through a slot that needs words in front of it, and those words are dropped from the slot.
// So each opening word has its own intent, to put it back: "what's the weather" arrives as Say_whats with "the weather".
export const OPENERS = {
  to: "", please: "", what: "what", "what's": "what's", when: "when", "when's": "when's", who: "who", "who's": "who's", where: "where", "where's": "where's",
  why: "why", how: "how", "how's": "how's", is: "is", are: "are", am: "am", do: "do", does: "does", did: "did", has: "has", have: "have", can: "can", could: "could",
  will: "will", would: "would", should: "should", which: "which", turn: "turn", switch: "switch", put: "put", play: "play", pause: "pause", resume: "resume",
  stop: "stop", skip: "skip", mute: "mute", unmute: "unmute", set: "set", make: "make", dim: "dim", tell: "tell", give: "give", show: "show", check: "check",
  find: "find", search: "search", google: "google", get: "get", request: "request", download: "download", "it's": "it's", "that's": "that's", "i'm": "i'm", i: "i",
  my: "my", any: "any", anything: "anything", volume: "volume", lights: "lights", remind: "remind", wake: "wake"
};
export const intentName = word => "Say_" + word.replace(/[^a-z]/g, "");
export const OPENER_BY_INTENT = Object.fromEntries(Object.entries(OPENERS).map(([word, kept]) => [intentName(word), kept]));
