# Jarvis Companion for macOS

This small Python 3 helper lets the signed-in Homebase Jarvis page open an allowlisted app or website on this Mac. It binds only to `127.0.0.1`; it has no remote listener, shell command, mouse/keyboard control, file access, or screen access. It is off until you launch it and pair it in Jarvis Settings.

## Start and pair

On the Mac where you use Homebase, run:

```sh
python3 jarvis_companion.py
```

The terminal prints a one-time pairing code that expires after five minutes. In Jarvis, open **Settings → LAPTOP COMPANION**, enter that code, and choose **PAIR THIS TAB**. The resulting token stays in this browser tab's `sessionStorage`; it is not written into the repository or companion config. Stop the helper with Ctrl-C. Restarting it creates a new code and revokes the old token.

When paired, commands such as “open app Safari” and “open website GitHub” launch only names in the helper's catalog. A site alias maps to one fixed HTTPS URL. To add or remove choices, create `~/Library/Application Support/Homebase Jarvis/config.json` using this shape:

```json
{
  "apps": {"safari": "Safari", "notes": "Notes"},
  "websites": {"homebase": "https://dashboard.danielvault.uk/", "github": "https://github.com/"},
  "allowed_hosts": ["dashboard.danielvault.uk", "github.com"]
}
```

App names are passed as one argument to macOS `open -a`; no shell is involved. Website aliases must use HTTPS and a host in `allowed_hosts`. Keep this file private to your Mac account and only add apps/sites you want Jarvis to open.

## Screen questions

Screen sharing is separate and starts only after you press the screen button and pick a screen/window in the browser. The browser displays its normal sharing indicator. While sharing, Jarvis captures one resized JPEG only when you submit a question. It is sent through the authenticated Homebase Pages Function and private bridge to the Jarvis server, then to the configured Anthropic Claude vision model for analysis. The Pages Function and Jarvis do not save the frame or add it to chat history; the configured model provider receives it to answer. Stop sharing at any time, close the tab, or hide it to stop capture. This feature does not make a video recording.

## Limits

- macOS only in this first companion build; Python 3 is required.
- The companion must remain running, and each browser tab must pair again after a companion restart.
- Only explicitly catalogued app and website aliases are accepted. No arbitrary URLs, commands, mouse, keyboard, form submission, deleting, or purchasing.
- Browser screen capture support depends on the browser and operating system. It requires a secure Homebase page and a direct click to open the browser picker.
