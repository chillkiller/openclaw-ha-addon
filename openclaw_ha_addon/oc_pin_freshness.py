#!/usr/bin/env python3
"""Check release pins against the npm registry ``latest`` dist-tag.

This is a release-time maintenance command. It is deliberately not imported or
executed by the image build or application startup, so the runtime remains
pinned and reproducible. Only the Python standard library is used.
"""

import argparse
import ast
import json
import re
import shlex
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence, TextIO

ADDON_DIR = Path(__file__).resolve().parent
HELPER_PATH = ADDON_DIR / "oc_acpx_helper.py"
DOCKERFILE_PATH = ADDON_DIR / "Dockerfile"
REGISTRY_ROOT = "https://registry.npmjs.org"
DEFAULT_TIMEOUT_SECONDS = 10.0

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_REGISTRY_ERROR = 2
EXIT_PIN_ERROR = 3

RUNTIME_FAMILY = "runtime"
HARNESS_FAMILY = "harness"
IMAGE_FAMILY = "image"

IMAGE_PIN_PACKAGES = ("node-llama-cpp", "mcporter", "pnpm")


class PinParseError(ValueError):
    """A declared package pin could not be read without importing the helper."""


class RegistryError(RuntimeError):
    """The current npm ``latest`` version could not be determined."""


@dataclass(frozen=True)
class PackagePin:
    package: str
    pin: str
    family: str


# Package names are constants too, so renamed scoped packages cannot silently
# evade the release gate. Versions are read from the default argument of the
# existing os.environ.get(...) declarations; environment overrides do not
# change the source pin that is shipped in a release.
HELPER_PIN_DECLARATIONS = (
    ("ACPX_PACKAGE", "OPENCLAW_ACPX_VERSION", RUNTIME_FAMILY),
    ("OPENCODE_PACKAGE", "OPENCODE_VERSION", HARNESS_FAMILY),
    ("PI_PACKAGE", "PI_VERSION", HARNESS_FAMILY),
    ("COPILOT_PACKAGE", "COPILOT_VERSION", HARNESS_FAMILY),
    ("KILO_PACKAGE", "KILO_VERSION", HARNESS_FAMILY),
    ("QWEN_PACKAGE", "QWEN_VERSION", HARNESS_FAMILY),
    ("GEMINI_PACKAGE", "GEMINI_VERSION", HARNESS_FAMILY),
    ("DROID_PACKAGE", "DROID_VERSION", HARNESS_FAMILY),
    ("IFLOW_PACKAGE", "IFLOW_VERSION", HARNESS_FAMILY),
)


def _declared_string(node: ast.AST, constant_name: str) -> str:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "get"
        and isinstance(node.func.value, ast.Attribute)
        and node.func.value.attr == "environ"
        and isinstance(node.func.value.value, ast.Name)
        and node.func.value.value.id == "os"
        and len(node.args) == 2
        and isinstance(node.args[1], ast.Constant)
        and isinstance(node.args[1].value, str)
    ):
        return node.args[1].value
    raise PinParseError(f"{constant_name} is not a literal package name or defaulted version")


def extract_helper_pins(path: Path = HELPER_PATH) -> list[PackagePin]:
    """Extract declared helper package/version pairs through AST inspection."""

    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    required = {name for declaration in HELPER_PIN_DECLARATIONS for name in declaration[:2]}
    constants: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name) and target.id in required:
            constants[target.id] = _declared_string(node.value, target.id)

    missing = sorted(required - constants.keys())
    if missing:
        raise PinParseError(f"missing package pin declarations: {', '.join(missing)}")
    return [
        PackagePin(constants[package_name], constants[version_name], family)
        for package_name, version_name, family in HELPER_PIN_DECLARATIONS
    ]


def extract_runtime_pin(path: Path = DOCKERFILE_PATH) -> PackagePin:
    """Read the actual image install pin rather than maintaining a duplicate."""

    matches = [pin for pin in extract_dockerfile_pins(path) if pin.package == "openclaw"]
    if len(matches) != 1:
        raise PinParseError(f"expected exactly one OpenClaw image pin, found {len(matches)}")
    return matches[0]


def extract_dockerfile_pins(path: Path = DOCKERFILE_PATH) -> list[PackagePin]:
    """Extract every global npm pin from tokenized Dockerfile RUN commands.

    Docker instructions are joined at continuations and shell-tokenized, not
    executed. This is the Dockerfile counterpart of the helper's AST parsing:
    adding another bundled global npm package automatically adds a gate row,
    while malformed or duplicate package specifications fail closed.
    """

    instructions: list[str] = []
    logical = ""
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not logical:
            stripped = raw_line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            logical = raw_line.lstrip()
        else:
            logical += " " + raw_line.strip()
        if logical.rstrip().endswith("\\"):
            logical = logical.rstrip()[:-1]
            continue
        instructions.append(logical)
        logical = ""
    if logical:
        raise PinParseError("unterminated Dockerfile continuation")

    pins: list[PackagePin] = []
    seen: set[str] = set()
    for instruction in instructions:
        if instruction[:4].upper() != "RUN ":
            continue
        try:
            tokens = shlex.split(instruction[4:], posix=True)
        except ValueError as error:
            raise PinParseError(f"could not tokenize Dockerfile RUN command: {error}") from error
        for index in range(len(tokens) - 3):
            if tokens[index:index + 3] != ["npm", "install", "-g"]:
                continue
            spec = tokens[index + 3]
            package, separator, pin = spec.rpartition("@")
            if (
                not separator
                or not re.fullmatch(r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*", package)
                or not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+_-]*", pin)
            ):
                raise PinParseError(f"invalid global npm package pin: {spec!r}")
            if package in seen:
                raise PinParseError(f"duplicate global npm package pin: {package}")
            seen.add(package)
            family = RUNTIME_FAMILY if package == "openclaw" else IMAGE_FAMILY
            pins.append(PackagePin(package, pin, family))
    return pins


def extract_image_pins(path: Path = DOCKERFILE_PATH) -> list[PackagePin]:
    """Return every non-runtime global npm pin shipped by the image."""

    image_pins = [
        pin for pin in extract_dockerfile_pins(path)
        if pin.package != "openclaw"
    ]
    present = {pin.package for pin in image_pins}
    missing = sorted(set(IMAGE_PIN_PACKAGES) - present)
    if missing:
        raise PinParseError(f"missing image npm pins: {', '.join(missing)}")
    return image_pins


def load_pins(
    helper_path: Path = HELPER_PATH,
    dockerfile_path: Path = DOCKERFILE_PATH,
) -> list[PackagePin]:
    return [
        extract_runtime_pin(dockerfile_path),
        *extract_helper_pins(helper_path),
        *extract_image_pins(dockerfile_path),
    ]


def fetch_latest(package: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> str:
    """Return the registry ``dist-tags.latest`` value or raise RegistryError."""

    url = f"{REGISTRY_ROOT}/{urllib.parse.quote(package, safe='')}"
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "openclaw-ha-addon-pin-freshness"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
        latest = payload.get("dist-tags", {}).get("latest")
        if not isinstance(latest, str) or not latest.strip():
            raise RegistryError(f"{package}: registry response has no dist-tags.latest string")
        return latest
    except RegistryError:
        raise
    except (
        urllib.error.HTTPError,
        urllib.error.URLError,
        TimeoutError,
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ) as error:
        raise RegistryError(f"{package}: npm registry lookup failed: {error}") from error


def check_pins(
    pins: Sequence[PackagePin],
    *,
    strict: bool = False,
    registry_lookup: Callable[[str, float], str] = fetch_latest,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    """Print one verdict per package and return the process-style exit code."""

    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    drift = False
    registry_failed = False
    for package_pin in pins:
        try:
            latest = registry_lookup(package_pin.package, timeout)
        except Exception as error:  # A failed lookup must never become a silent pass.
            registry_failed = True
            print(
                f"{package_pin.package} | pin={package_pin.pin} | latest=unavailable | ERROR",
                file=out,
            )
            print(f"ERROR: {error}", file=err)
            continue

        if latest == package_pin.pin:
            verdict = "OK"
        elif package_pin.family == RUNTIME_FAMILY or strict:
            verdict = "FAIL"
            drift = True
        else:
            verdict = "WARN"
        print(
            f"{package_pin.package} | pin={package_pin.pin} | latest={latest} | {verdict}",
            file=out,
        )

    if registry_failed:
        print("ERROR: npm registry freshness is unknown; refusing to pass the release gate.", file=err)
        return EXIT_REGISTRY_ERROR
    return EXIT_DRIFT if drift else EXIT_OK


def main(
    argv: Sequence[str] | None = None,
    *,
    registry_lookup: Callable[[str, float], str] = fetch_latest,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="fail on any non-runtime drift as well as runtime-family drift",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"timeout in seconds for each registry request (default: {DEFAULT_TIMEOUT_SECONDS:g})",
    )
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    try:
        pins = load_pins()
    except (OSError, SyntaxError, PinParseError) as error:
        print(f"ERROR: could not load release pins: {error}", file=stderr or sys.stderr)
        return EXIT_PIN_ERROR
    return check_pins(
        pins,
        strict=args.strict,
        registry_lookup=registry_lookup,
        timeout=args.timeout,
        stdout=stdout,
        stderr=stderr,
    )


if __name__ == "__main__":
    sys.exit(main())
