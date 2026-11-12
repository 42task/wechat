#!/usr/bin/env python3
"""Check resolved Compose overrides without exposing application environment values."""

import argparse
import json
from pathlib import Path
import subprocess
import sys


IMAGE_OWNED_KEYS = (
    "GIT_COMMIT",
    "BUILD_TIME",
    "PATH",
    "NODE_VERSION",
    "YARN_VERSION",
)


class PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's normal error can repeat user-supplied arguments or paths.
        self.exit(2, "Deployment preflight failed: invalid arguments.\n")


def configuration_failure():
    print(
        "Deployment preflight failed: unable to resolve Compose configuration.",
        file=sys.stderr,
    )
    return 2


def main():
    parser = PrivateArgumentParser(
        prog="check-image-deployment.py",
        description="Check image-owned environment overrides using Compose config only.",
        allow_abbrev=False,
    )
    parser.add_argument("--env-file", required=True, metavar="PATH")
    parser.add_argument("--project-name", "-p", default="wechat2", metavar="NAME")
    args = parser.parse_args()

    try:
        root = Path(__file__).resolve().parent.parent
        env_file = Path(args.env_file).expanduser().resolve()
        # Inherit the operator's normal Compose interpolation environment. Do not
        # source/export the env file or modify it. Compose resolves env_file itself.
        result = subprocess.run(
            [
                "docker", "compose",
                "--project-name", args.project_name,
                "--env-file", str(env_file),
                "-f", str(root / "compose.image.yaml"),
                "config", "--format", "json",
            ],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        # Compose stdout contains full resolved secrets, and errors can repeat
        # sensitive input. Neither stream may be printed, logged, or persisted.
        if result.returncode != 0:
            return configuration_failure()
        configuration = json.loads(result.stdout)
        services = configuration.get("services") if isinstance(configuration, dict) else None
        service = services.get("wechat2") if isinstance(services, dict) else None
        environment = service.get("environment") if isinstance(service, dict) else None
        if not isinstance(environment, dict):
            return configuration_failure()
        found = [key for key in IMAGE_OWNED_KEYS if key in environment]
    except (OSError, ValueError, subprocess.SubprocessError):
        return configuration_failure()

    if found:
        print(f"Image-owned environment keys ({len(found)}): {', '.join(found)}")
        return 1
    print("Deployment preflight passed: no image-owned environment overrides.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
