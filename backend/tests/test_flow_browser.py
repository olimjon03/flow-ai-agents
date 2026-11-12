import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from flow_api.studio.flow_browser import FLOW_URL, DownloadsWatcher, LocalError, launch_chrome, snapshot_mp4


class BrowserLauncherTests(unittest.TestCase):
    def test_requires_opt_in_and_explicit_launch(self):
        with patch.dict("os.environ", {"FLOW_GOOGLE_FLOW_BROWSER_POC": "0"}), patch("subprocess.Popen") as spawn:
            with self.assertRaisesRegex(LocalError, "FLOW_GOOGLE_FLOW_BROWSER_POC"):
                launch_chrome(True)
            spawn.assert_not_called()
        with patch.dict("os.environ", {"FLOW_GOOGLE_FLOW_BROWSER_POC": "1"}), patch("subprocess.Popen") as spawn:
            with self.assertRaisesRegex(LocalError, "--confirm-open"):
                launch_chrome(False)
            spawn.assert_not_called()

    def test_launch_is_manual_with_an_isolated_profile(self):
        with tempfile.TemporaryDirectory() as directory, patch("pathlib.Path.home", return_value=Path(directory)), \
                patch.dict("os.environ", {"FLOW_GOOGLE_FLOW_BROWSER_POC": "1", "GEMINI_API_KEY": "fixture-only"}), \
                patch("shutil.which", return_value="/fake/google-chrome"), patch("subprocess.Popen") as spawn:
            self.assertEqual(launch_chrome(True)["state"], "login_required")
            argv = spawn.call_args.args[0]
            self.assertEqual(argv[-1], FLOW_URL)
            self.assertIn(f"--user-data-dir={directory}/.flow-ai-google-flow-browser", argv)
            self.assertFalse(any("debugging" in value or "automation" in value for value in argv))
            self.assertNotIn("GEMINI_API_KEY", spawn.call_args.kwargs["env"])

    def test_rejects_symlink_profile_without_launching(self):
        with tempfile.TemporaryDirectory() as directory, patch("pathlib.Path.home", return_value=Path(directory)), \
                patch.dict("os.environ", {"FLOW_GOOGLE_FLOW_BROWSER_POC": "1"}), \
                patch("shutil.which", return_value="/fake/google-chrome"), patch("subprocess.Popen") as spawn:
            target = Path(directory) / "personal-profile"
            target.mkdir()
            (Path(directory) / ".flow-ai-google-flow-browser").symlink_to(target)
            with self.assertRaisesRegex(LocalError, "private directory"):
                launch_chrome(True)
            spawn.assert_not_called()


class DownloadsWatcherTests(unittest.IsolatedAsyncioTestCase):
    async def test_incomplete_duplicate_and_changed_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            probe = AsyncMock()
            probe.probe.return_value = 6
            watcher = DownloadsWatcher(root, probe)
            sample = b"\x00\x00\x00\x14ftypisom\x00\x00\x00\x00isomfixture"
            (root / "flow.mp4").write_bytes(sample)
            incomplete = root / "flow.mp4.crdownload"
            incomplete.write_bytes(b"downloading")
            self.assertEqual(await watcher.scan(), [])
            self.assertEqual(await watcher.scan(), [])
            probe.probe.assert_not_called()
            incomplete.unlink()
            self.assertEqual(await watcher.scan(), [])
            (root / "flow.mp4").write_bytes(sample + b"changed")
            self.assertEqual(await watcher.scan(), [])
            detected, = await watcher.scan()
            self.assertEqual(detected["state"], "ready")
            self.assertEqual(detected["sha256"], hashlib.sha256(sample + b"changed").hexdigest())
            probe.probe.assert_awaited_once()
            (root / "duplicate.mp4").write_bytes(sample + b"changed")
            self.assertEqual(await watcher.scan(), [])
            self.assertEqual(await watcher.scan(), [{"state": "duplicate_download", "file": "duplicate.mp4"}])
            probe.probe.assert_awaited_once()

    async def test_missing_and_denied_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            missing = root / "missing.mp4"
            with self.assertRaises(LocalError) as error:
                with snapshot_mp4(missing):
                    self.fail("Missing file was opened")
            self.assertEqual(error.exception.state, "missing_file")
            symlink = root / "external"
            symlink.symlink_to(root, target_is_directory=True)
            with self.assertRaises(LocalError) as error:
                await DownloadsWatcher(symlink, AsyncMock()).scan()
            self.assertEqual(error.exception.state, "denied")
