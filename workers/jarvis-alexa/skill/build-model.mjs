// Writes interaction-model.json, the file Daniel pastes into the Alexa developer console. Run with node.
import { writeFileSync } from "node:fs";
import { OPENERS, intentName } from "../src/phrases.js";

const openers = Object.keys(OPENERS).map(word => ({
  name: intentName(word),
  slots: [{ name: "text", type: "AMAZON.SearchQuery" }],
  samples: [`${word} {text}`]
}));
const answers = ["the living room", "living room", "the passage", "passage", "daniel's room", "daniel's tv", "mum's tv", "mum's bedroom", "the first one", "the second one", "the third one", "this evening", "tomorrow morning", "all of them"];
const model = {
  interactionModel: {
    languageModel: {
      invocationName: "jarvis",
      intents: [
        ...["CancelIntent", "HelpIntent", "StopIntent", "NavigateHomeIntent", "YesIntent", "NoIntent", "FallbackIntent"].map(n => ({ name: "AMAZON." + n, samples: [] })),
        ...openers,
        { name: "AnswerIntent", slots: [{ name: "answer", type: "ANSWER_WORDS" }], samples: ["{answer}"] }
      ],
      types: [{ name: "ANSWER_WORDS", values: answers.map(value => ({ name: { value } })) }]
    }
  }
};
writeFileSync(new URL("./interaction-model.json", import.meta.url), JSON.stringify(model, null, 2) + "\n");
