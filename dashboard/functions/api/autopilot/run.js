import { json } from "../../_utils/downloads-auth.js";
import { runAutopilot, verifyRunToken } from "../../_utils/autopilot.js";

// The scheduled run: the bridge Worker's cron calls this every 15 minutes with its token,
// and the Worker itself confirms the token over the private binding.
export async function onRequestPost({ request, env }) {
  if (!await verifyRunToken(env, request.headers.get("x-autopilot-token") || "")) return json({ error: "Not allowed." }, 403);
  try {
    const state = await runAutopilot(env, "schedule");
    return json({ ok: true, fixed: state.lastRun.fixed, needsYou: state.lastRun.needsYou.length });
  } catch (error) {
    return json({ ok: false, error: error?.message || "Autopilot couldn't finish." }, 502);
  }
}
