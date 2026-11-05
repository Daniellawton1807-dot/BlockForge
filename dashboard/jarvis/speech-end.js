/* Deciding when he's finished talking. Apart from the page so it can be run against pretend audio, where blocks are 80 ms each. */
(function (root) {
  const SPEECH_FLOOR = 0.012, SPEECH_OVER_NOISE = 3, MIN_SPEECH_BLOCKS = 3;
  const QUICK_QUIET = 10, LONG_QUIET = 20, QUICK_TALK = 12, LONG_TALK = 30;  // a short command ends after 0.8 s of quiet, a long request after 1.6 s
  const LEARN_BLOCKS = 6, VOICE_SHARE = 0.25, TAIL_BLOCKS = 6;  // well below his own level is someone across the room, and counts as quiet

  function quietNeeded(speech) {
    const growth = Math.max(0, Math.min(1, (speech - QUICK_TALK) / (LONG_TALK - QUICK_TALK)));
    return Math.round(QUICK_QUIET + growth * (LONG_QUIET - QUICK_QUIET));
  }
  /* One block of a recording, already added to r.blocks. Whether that's the end of what he said. */
  function heard(r, level, noise) {
    const voice = r.speech >= LEARN_BLOCKS ? r.voice * VOICE_SHARE : 0;
    if (level > Math.max(SPEECH_FLOOR, noise * SPEECH_OVER_NOISE, voice)) {
      r.speech++; r.silent = 0; r.lastSpeech = r.blocks.length;
      r.voice = r.voice ? r.voice * 0.92 + level * 0.08 : level;
    } else r.silent++;
    return r.speech >= MIN_SPEECH_BLOCKS && r.silent >= quietNeeded(r.speech);
  }
  /* What's worth sending: his words and a moment after, not whoever carried on once he'd stopped. */
  function kept(r) {
    return r.speech >= MIN_SPEECH_BLOCKS && r.lastSpeech ? r.blocks.slice(0, r.lastSpeech + TAIL_BLOCKS) : r.blocks;
  }
  root.jarvisSpeech = { heard, kept, quietNeeded, MIN_SPEECH_BLOCKS };
})(typeof window === "undefined" ? globalThis : window);
