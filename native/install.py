"""Install the native writer for this user, without modifying browser profiles."""
import argparse
import json
from pathlib import Path
import re
import shlex
import shutil
import sys

HOST_NAME = "com.teams_transcript_capture.writer"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def install(extension_ids, home):
    if not extension_ids or any(not re.fullmatch(r"[a-p]{32}", value) for value in extension_ids):
        raise ValueError("Pass unpacked extension ID(s), 32 letters a-p")
    home = home.resolve()
    root = home / ".local/share/teams-transcript-capture"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(Path(__file__).with_name("host.py"), root / "host.py")
    (root / "host.py").chmod(0o600)
    routes = {
        "cdk": str(home / "Library/CloudStorage/OneDrive-CDKGlobalLLC/transcript"),
        "tao": str(home / "Library/CloudStorage/OneDrive-TaoDigitalSolutionsInc/transcript"),
    }
    origins = [f"chrome-extension://{value}/" for value in extension_ids]
    write_json(root / "routes.json", routes)
    write_json(root / "allowed_origins.json", origins)
    launcher = root / "run-host"
    launcher.write_text(f"#!/bin/sh\nexec {shlex.quote(sys.executable)} {shlex.quote(str(root / 'host.py'))} \"$@\"\n")
    launcher.chmod(0o700)
    manifest = {"name": HOST_NAME, "description": "Teams transcript local OneDrive writer", "path": str(launcher), "type": "stdio", "allowed_origins": origins}
    # Arc builds have used different Chromium user-data/native-host locations.
    for relative in ("Arc/User Data", "Arc", "Google/Chrome"):
        location = home / "Library/Application Support" / relative / "NativeMessagingHosts" / f"{HOST_NAME}.json"
        write_json(location, manifest)
        print(f"Registered: {location}")
    print(f"Writer: {launcher}")
    for key, path in routes.items():
        print(f"{key}: {path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", action="append", required=True)
    parser.add_argument("--home", type=Path, default=Path.home())
    args = parser.parse_args()
    install(args.extension_id, args.home)
