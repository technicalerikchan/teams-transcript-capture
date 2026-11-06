import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("host", Path(__file__).parents[1] / "native/host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.routes = {key: self.root / key / "transcript" for key in ("cdk", "tao")}
        for path in self.routes.values():
            path.parent.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, route="cdk", name="meeting.md", content="逐字稿\n"):
        return host.handle({"action": "write", "route": route, "name": name, "content": content}, self.routes)

    def test_isolated_routes(self):
        for route in ("cdk", "tao"):
            reply = self.write(route)
            self.assertEqual(Path(reply["path"]).parent, self.routes[route])
            self.assertEqual(Path(reply["path"]).read_text(), "逐字稿\n")
            self.assertEqual(Path(reply["path"]).stat().st_mode & 0o777, 0o600)

    def test_retry_is_idempotent(self):
        self.assertEqual(self.write()["path"], self.write()["path"])
        self.assertEqual(len(list(self.routes["cdk"].glob("*.md"))), 1)

    def test_no_overwriting(self):
        first = self.write()
        second = self.write(content="Another meeting")
        self.assertNotEqual(first["path"], second["path"])
        self.assertEqual(Path(first["path"]).read_text(), "逐字稿\n")

    def test_path_traversal_and_invalid_routes(self):
        for name in ("../meeting.md", "/tmp/meeting.md", "folder\\meeting.md", "bad\x00.md", "file.txt"):
            with self.assertRaises(ValueError):
                self.write(name=name)
        with self.assertRaises(ValueError):
            self.write(route="unknown")

    def test_missing_mount_does_not_create_onedrive_root(self):
        self.routes["cdk"].parent.rmdir()
        with self.assertRaises(ValueError):
            self.write()
        self.assertFalse(self.routes["cdk"].parent.exists())

    def test_symlink_cannot_redirect_destination_or_overwrite_file(self):
        self.routes["cdk"].symlink_to(self.routes["tao"].parent)
        with self.assertRaises(ValueError):
            self.write()
        self.routes["cdk"].unlink()
        self.routes["cdk"].mkdir()
        target = self.root / "untouched.md"
        target.write_text("Keep")
        (self.routes["cdk"] / "meeting.md").symlink_to(target)
        reply = self.write()
        self.assertNotEqual(Path(reply["path"]).name, "meeting.md")
        self.assertEqual(target.read_text(), "Keep")


if __name__ == "__main__":
    unittest.main()
