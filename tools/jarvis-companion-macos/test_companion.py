import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name("jarvis_companion.py")
spec = importlib.util.spec_from_file_location("jarvis_companion", MODULE)
companion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(companion)


class CompanionSecurityTests(unittest.TestCase):
    def test_pairing_code_is_single_use_and_token_is_required(self):
        pair = companion.Pairing()
        code = pair.code
        token = pair.pair(code)
        self.assertTrue(token)
        self.assertTrue(pair.authorized("Bearer " + token))
        self.assertFalse(pair.authorized(""))
        self.assertFalse(pair.pair(code))

    def test_disconnect_revokes_the_token_immediately(self):
        pair = companion.Pairing()
        token = pair.pair(pair.code)
        self.assertTrue(pair.authorized("Bearer " + token))
        self.assertTrue(pair.disconnect("Bearer " + token))
        self.assertFalse(pair.authorized("Bearer " + token))
        self.assertFalse(pair.disconnect("Bearer " + token))

    def test_bad_pair_code_cannot_be_retried_indefinitely(self):
        pair = companion.Pairing()
        for _ in range(5):
            self.assertFalse(pair.pair("wrong"))
        self.assertFalse(pair.pair(pair.code))

    def test_website_must_be_https_and_allowlisted(self):
        config = {"websites": {"good": "https://github.com/", "bad": "http://github.com/", "other": "https://example.com/"},
                  "allowed_hosts": ["github.com"]}
        self.assertEqual(companion.website_url("good", config), "https://github.com/")
        self.assertIsNone(companion.website_url("bad", config))
        self.assertIsNone(companion.website_url("other", config))

    def test_only_allowlisted_app_and_site_aliases_launch(self):
        config = {"apps": {"notes": "Notes"}, "websites": {"homebase": "https://dashboard.danielvault.uk/"},
                  "allowed_hosts": ["dashboard.danielvault.uk"]}
        with patch.object(companion.subprocess, "run") as run:
            self.assertEqual(companion.launch_action({"kind": "app", "name": "notes"}, config), (200, {"ok": True}))
            self.assertEqual(run.call_args.args[0], ["/usr/bin/open", "-a", "Notes"])
            self.assertEqual(companion.launch_action({"kind": "website", "name": "homebase"}, config), (200, {"ok": True}))
            self.assertEqual(run.call_args.args[0], ["/usr/bin/open", "https://dashboard.danielvault.uk/"])
            self.assertEqual(companion.launch_action({"kind": "app", "name": "terminal"}, config)[0], 400)
            self.assertEqual(companion.launch_action({"kind": "website", "name": "https://evil.example"}, config)[0], 400)
            self.assertEqual(run.call_count, 2)


if __name__ == "__main__":
    unittest.main()
