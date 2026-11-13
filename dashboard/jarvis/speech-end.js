/* Deciding when he's finished talking. Apart from the page so it can be run against pretend audio, where blocks are 80 ms each. */
(function (root) {
  const SPEECH_FLOOR = 0.012, SPEECH_OVER_NOISE = 3, MIN_SPEECH_BLOCKS = 3;
  // Allow natural pauses: short commands end after 2 s of quiet, longer requests after up to 3.2 s.
  const QUICK_QUIET = 25, LONG_QUIET = 40, QUICK_TALK = 12, LONG_TALK = 40;
  // with Silero: speech starts at 0.5 and carries on down to 0.3, so a soft syllable doesn't break it; quieter than a quarter of his own
  // voice is still the TV or someone across the room, however speech-like
  const VAD_ON = 0.5, VAD_HOLD = 0.3, VAD_FLOOR = 0.004, VAD_OVER_NOISE = 2, VAD_SHARE = 0.4;  // 6 dB over the room as it was before he spoke: a TV's
  // dialogue is speech too, so it has to be told apart by loudness, and before he says anything his own level isn't known yet
  const LEARN_BLOCKS = 6, VOICE_SHARE = 0.25, TAIL_BLOCKS = 6;  // well below his own level is someone across the room, and counts as quiet

  function quietNeeded(speech) {
    const growth = Math.max(0, Math.min(1, (speech - QUICK_TALK) / (LONG_TALK - QUICK_TALK)));
    return Math.round(QUICK_QUIET + growth * (LONG_QUIET - QUICK_QUIET));
  }
  /* One block of a recording, already added to r.blocks. Whether that's the end of what he said. */
  function heard(r, level, noise) {
    const voice = r.speech >= LEARN_BLOCKS ? r.voice * VOICE_SHARE : 0;
    if (level > Math.max(SPEECH_FLOOR, noise * SPEECH_OVER_NOISE, voice)) {
      r.speech++; r.silent = 0; r.lastSpeech = r.judged == null ? r.blocks.length : (r.base || 0) + r.judged;
      r.voice = r.voice ? r.voice * 0.92 + level * 0.08 : level;
    } else r.silent++;
    return r.speech >= MIN_SPEECH_BLOCKS && r.silent >= quietNeeded(r.speech);
  }
  /* The same, going by Silero's speech probability for the block (p) as well as its loudness: noise, music and clatter aren't speech
     however loud, and the TV's voices are quieter than his. */
  function heardVad(r, p, level, noise) {
    const speechy = p >= VAD_ON || (r.talking && p >= VAD_HOLD);
    // his voice is the loudest speech in the recording (he's nearest the mic): followed as a slowly fading peak, so once he's spoken,
    // voices well below him (the TV's) are quiet, even if they were there first
    if (speechy) r.peak = Math.max(level, (r.peak || 0) * 0.995);
    const his = r.peak ? r.peak * VAD_SHARE : 0;
    if (speechy && level > Math.max(VAD_FLOOR, (noise || 0) * VAD_OVER_NOISE, his)) {
      r.speech++; r.silent = 0; r.talking = true; r.lastSpeech = (r.base || 0) + r.judged;
      r.voice = r.voice ? r.voice * 0.92 + level * 0.08 : level;
    } else { r.silent++; r.talking = false; }
    return r.speech >= MIN_SPEECH_BLOCKS && r.silent >= quietNeeded(r.speech);
  }
  /* What's worth sending: his words and a moment after, not whoever carried on once he'd stopped. */
  function kept(r) {
    return r.speech >= MIN_SPEECH_BLOCKS && r.lastSpeech ? r.blocks.slice(0, r.lastSpeech + TAIL_BLOCKS) : r.blocks;
  }
  root.jarvisSpeech = { heard, heardVad, kept, quietNeeded, MIN_SPEECH_BLOCKS };
})(typeof window === "undefined" ? globalThis : window);
