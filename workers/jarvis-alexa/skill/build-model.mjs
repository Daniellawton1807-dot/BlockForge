// Writes interaction-model.json, the file Daniel pastes into the Alexa developer console. Run with node.
import { writeFileSync } from "node:fs";
import { OPENERS, intentName } from "../src/phrases.js";

const openers = Object.keys(OPENERS).map(word => ({
  name: intentName(word),
  slots: [{ name: "text", type: "AMAZON.SearchQuery" }],
  samples: [`${word} {text}`]
}));
// Sentences, so Alexa treats this slot as free speech. Without a FallbackIntent it has to pick one of these intents and pass the words on.
const sentences = ["turn down the living room tv", "turn off the lights in the passage", "what's the weather like tomorrow", "what time is f1 practice tomorrow", "is anything downloading",
  "play the next episode", "put something funny on", "it's too dark in here", "i can't hear it", "i'm going to bed", "how much space have i got left", "who's in this film",
  "wake me at seven tomorrow", "search the web for the best air fryer", "pause the film on mum's tv", "tell me a joke", "good evening", "is the minecraft server on", "how long until dune is ready", "say that again"];
const answers = [...sentences, "the living room", "living room", "the passage", "passage", "daniel's room", "daniel's tv", "mum's tv", "mum's bedroom", "the first one", "the second one", "the third one", "this evening", "tomorrow morning", "all of them"];
const model = {
  interactionModel: {
    languageModel: {
      invocationName: "jarvis",
      intents: [
        ...["CancelIntent", "HelpIntent", "StopIntent", "NavigateHomeIntent", "YesIntent", "NoIntent"].map(n => ({ name: "AMAZON." + n, samples: [] })),
        ...openers,
        { name: "AnswerIntent", slots: [{ name: "answer", type: "ANSWER_WORDS" }], samples: ["{answer}"] }  // deliberately no FallbackIntent: it swallowed whole sentences and passes on no words
      ],
      types: [{ name: "ANSWER_WORDS", values: answers.map(value => ({ name: { value } })) }]
    }
  }
};
writeFileSync(new URL("./interaction-model.json", import.meta.url), JSON.stringify(model, null, 2) + "\n");
