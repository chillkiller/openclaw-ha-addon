#!/usr/bin/env python3
"""Resolve the Node.js release that the pinned OpenClaw build actually wants.

The add-on must not carry a hard-coded Node patch version: OpenClaw declares
the Node lines it supports in ``engines.node`` and that range moves over time
(24.x -> 26.x -> 27.x). This helper therefore

1. reads ``engines.node`` of the pinned OpenClaw version from the npm registry,
2. loads the published Node.js release list,
3. picks the newest release that satisfies that range,
4. reports the matching NodeSource major line so the image build can install
   that line *without* pinning a patch version (the repository always ships the
   newest patch of the line),
5. optionally verifies an installed version against the same range.

Only the Python standard library is used, so the helper runs during the image
build before Node.js itself is installed.
"""

import argparse
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

REGISTRY_ROOT = "https://registry.npmjs.org"
NODE_RELEASES_URL = "https://nodejs.org/dist/index.json"
NODESOURCE_RELEASE_URL = "https://deb.nodesource.com/node_{major}.x/dists/nodistro/Release"
DEFAULT_TIMEOUT_SECONDS = 20.0

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_REGISTRY_ERROR = 3
EXIT_VERIFY_FAILED = 4
EXIT_NO_MATCH = 5
EXIT_FLOOR_VIOLATION = 6

# The secure patch floor per Node major line is NOT kept here: the runtime
# ships that table itself (NODE_SECURITY_RELEASE_FLOORS in the installed
# OpenClaw package) and the helper reads it from there
# (runtime_security_floors()). A second copy would only have to be maintained
# by hand and would be stale as soon as the runtime learns a new line.


class RegistryError(RuntimeError):
    """A required registry/release listing could not be read."""


@dataclass(frozen=True)
class NodeRelease:
    version: str
    major: str

    @property
    def tuple(self) -> tuple[int, ...]:
        return _version_tuple(self.version)


def _version_tuple(version: str) -> tuple[int, ...]:
    core = version.split("-", 1)[0]
    parts = []
    for chunk in core.split("."):
        match = re.match(r"^(\d+)", chunk)
        if not match:
            raise ValueError(f"not a version: {version!r}")
        parts.append(int(match.group(1)))
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def _prerelease_key(version: str) -> tuple:
    """Return a comparable key for the prerelease part of a version.

    A version without a prerelease is higher than every prerelease of the
    same core version (semver). Inside a prerelease, numeric identifiers rank
    below alphanumeric ones and compare numerically.
    """
    if "-" not in version:
        return (1,)
    raw = version.split("-", 1)[1]
    parts: list[tuple[int, int, str]] = []
    for chunk in raw.split("."):
        if chunk.isdigit():
            parts.append((0, int(chunk), ""))
        else:
            parts.append((1, 0, chunk))
    return (0, tuple(parts))


def _cmp(left: str, right: str) -> int:
    a, b = _version_tuple(left), _version_tuple(right)
    if a != b:
        return (a > b) - (a < b)
    a_pre, b_pre = _prerelease_key(left), _prerelease_key(right)
    if a_pre == b_pre:
        return 0
    return (a_pre > b_pre) - (a_pre < b_pre)


def _parse_token(token: str) -> tuple[str, str]:
    token = token.strip()
    if not token or token in ("*", "x", "X"):
        return "*", ""
    match = re.match(r"^(>=|<=|>|<|\^|~|=)?\s*v?(.+)$", token)
    if not match:
        raise ValueError(f"unsupported version range token: {token!r}")
    return match.group(1) or "=", match.group(2).strip()


def _numeric_parts(raw: str) -> list[int]:
    parts: list[int] = []
    for chunk in raw.split("."):
        match = re.match(r"^(\d+)", chunk)
        if not match:
            raise ValueError(f"not a version: {raw!r}")
        parts.append(int(match.group(1)))
    return parts


def _token_matches(token: str, version: str) -> bool:
    op, raw = _parse_token(token)
    if op == "*":
        return True
    if op == "=" and (raw.endswith(".x") or raw.endswith(".*")):
        prefix = raw.rstrip(".*x")
        # "24.x" and "24.16.x" both mean a whole line, not an exact version.
        return version == prefix or version.startswith(prefix + ".")
    if op in ("^", "~"):
        parts = _numeric_parts(raw)
        specified = len(parts)
        while len(parts) < 3:
            parts.append(0)
        major, minor, patch = parts[0], parts[1], parts[2]
        floor = (major, minor, patch)
        if op == "^":
            # npm caret semantics: the first non-zero component decides the
            # upper bound, and the number of specified components matters:
            # ^1.2.3 -> <2.0.0, ^1.2 -> <2.0.0, ^1 -> <2.0.0,
            # ^0.2.3 -> <0.3.0, ^0.2 -> <0.3.0, ^0 -> <1.0.0,
            # ^0.0.3 -> <0.0.4, ^0.0 -> <0.1.0.
            if major > 0:
                upper = (major + 1, 0, 0)
            elif specified >= 2 and minor > 0:
                upper = (0, minor + 1, 0)
            elif specified >= 3:
                upper = (0, 0, patch + 1)
            elif specified == 2:
                upper = (0, 1, 0)
            else:
                upper = (1, 0, 0)
        else:
            # npm tilde semantics: ~1.2.3 -> <1.3.0, ~1.2 -> <1.3.0, ~1 -> <2.0.0.
            if specified >= 2:
                upper = (major, minor + 1, 0)
            else:
                upper = (major + 1, 0, 0)
        return floor <= _version_tuple(version) < upper
    if op == "=":
        parts = _numeric_parts(raw)
        if len(parts) < 3 and raw.count(".") < 1:
            # A bare major ("24") means the whole line, like npm: >=24 <25.
            major = parts[0]
            return (major, 0, 0) <= _version_tuple(version) < (major + 1, 0, 0)
        if len(parts) < 3:
            # "24.16" means the whole minor line: >=24.16.0 <24.17.0.
            major, minor = parts[0], parts[1]
            return (major, minor, 0) <= _version_tuple(version) < (major, minor + 1, 0)
        return _cmp(version, raw) == 0
    if op == ">=":
        return _cmp(version, raw) >= 0
    if op == ">":
        return _cmp(version, raw) > 0
    if op == "<=":
        return _cmp(version, raw) <= 0
    if op == "<":
        return _cmp(version, raw) < 0
    raise ValueError(f"unsupported version range token: {token!r}")


def _is_prerelease(version: str) -> bool:
    return "-" in version


def _range_allows_prerelease(tokens: Sequence[str], version: str) -> bool:
    """npm rule: a prerelease only matches a range that mentions a prerelease
    of the same [major, minor, patch] tuple."""
    target = _version_tuple(version)
    for token in tokens:
        try:
            op, raw = _parse_token(token)
        except ValueError:
            continue
        if op == "*" or not raw or "-" not in raw:
            continue
        if _version_tuple(raw) == target:
            return True
    return False


def satisfies(version: str, range_expr: str) -> bool:
    """Return whether ``version`` satisfies a node-semver style range."""
    alternatives = [alt for alt in range_expr.split("||") if alt.strip()]
    if not alternatives:
        raise ValueError("empty version range")
    for alternative in alternatives:
        tokens = alternative.split()
        if not tokens:
            continue
        if _is_prerelease(version) and not _range_allows_prerelease(tokens, version):
            continue
        if all(_token_matches(token, version) for token in tokens):
            return True
    return False


def fetch_engines_range(
    package: str, version: str, timeout: float = DEFAULT_TIMEOUT_SECONDS
) -> str:
    url = f"{REGISTRY_ROOT}/{urllib.parse.quote(package, safe='@')}/{urllib.parse.quote(version, safe='@')}"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RegistryError(f"could not read {package}@{version} engines: {error}") from error
    engines = payload.get("engines") or {}
    node_range = engines.get("node")
    if not node_range:
        raise RegistryError(f"{package}@{version} declares no engines.node range")
    return node_range


def fetch_node_releases(timeout: float = DEFAULT_TIMEOUT_SECONDS) -> list[NodeRelease]:
    try:
        with urllib.request.urlopen(NODE_RELEASES_URL, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RegistryError(f"could not read the Node.js release list: {error}") from error
    releases = []
    for entry in payload:
        version = str(entry.get("version") or "")
        if not version.startswith("v"):
            continue
        if "-" in version:  # pre-releases are not installable via apt
            continue
        releases.append(NodeRelease(version=version[1:], major=version[1:].split(".")[0]))
    return releases


def nodesource_line_available(major: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> bool:
    """Return whether NodeSource ships an apt repository for this major line.

    A missing line (HTTP 404) is a normal answer: the caller then tries the
    next matching major line. A transport error is *not* the same thing - it
    would silently downgrade the image to an older Node line - so it aborts
    instead of being treated as "line not available".
    """
    url = NODESOURCE_RELEASE_URL.format(major=major)
    request = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return 200 <= response.status < 400
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise RegistryError(
            f"could not probe the NodeSource repository for Node {major}.x: HTTP {error.code}"
        ) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise RegistryError(
            f"could not probe the NodeSource repository for Node {major}.x: {error}"
        ) from error


def select_release(
    releases: Sequence[NodeRelease],
    range_expr: str,
    available_majors: Callable[[str], bool] | None = None,
    on_skip: Callable[[str], None] | None = None,
) -> tuple[NodeRelease, list[NodeRelease]]:
    """Return the newest release OpenClaw wants plus every matching release.

    The ``engines.node`` range is usually open-ended upwards
    (``>=24.16.0 <25 || >=26.1.0``), so "the newest version OpenClaw wants" is
    the newest release of the newest major line. That line must be installable,
    therefore each candidate major is checked against the NodeSource repository
    list before it is accepted.
    """
    matches = [release for release in releases if satisfies(release.version, range_expr)]
    if not matches:
        raise RegistryError(f"no published Node.js release satisfies {range_expr!r}")
    majors = sorted({release.major for release in matches}, key=int, reverse=True)
    for major in majors:
        if available_majors is not None and not available_majors(major):
            if on_skip is not None:
                on_skip(major)
            continue
        line = [release for release in matches if release.major == major]
        return max(line, key=lambda release: release.tuple), matches
    raise RegistryError(
        f"no Node.js major line satisfying {range_expr!r} is available for installation"
    )


def runtime_security_floors(package_dir: str) -> dict[str, str] | None:
    """Read the secure patch floors from an installed OpenClaw package.

    The runtime ships its own floor table (the minimum patch level per Node
    line that rejects the compromised public keys). Reading it from the
    installed package keeps the build aligned with the runtime without a
    second table to maintain: a new Node line is covered as soon as the
    runtime knows a floor for it.

    Returns None when the table cannot be found. There is no built-in
    fallback: the runtime is the single source of the floor, so a caller that
    asked for the runtime table must fail rather than continue unchecked.
    """
    root = Path(package_dir)
    dist = root / "dist"
    if not dist.is_dir():
        return None
    pattern = re.compile(r"major:\s*(\d+)\s*,\s*minor:\s*(\d+)\s*,\s*patch:\s*(\d+)")
    for path in sorted(dist.rglob("*.mjs")):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        marker = text.find("NODE_SECURITY_RELEASE_FLOORS")
        if marker < 0:
            continue
        # The table is the first array literal after the constant name.
        start = text.find("[", marker)
        end = text.find("]", start)
        if start < 0 or end < 0:
            continue
        floors: dict[str, str] = {}
        for major, minor, patch in pattern.findall(text[start:end]):
            floors[major] = f"{major}.{minor}.{patch}"
        if floors:
            return floors
    return None


def floor_for(major: str, runtime_floors: dict[str, str] | None = None) -> str | None:
    """Return the secure patch floor for a Node major line.

    The floor comes from the runtime's own table. Without it there is no floor
    to enforce: the range check still applies, and the post-install gate
    verifies the installed Node against the runtime's floors.
    """
    if runtime_floors:
        return runtime_floors.get(major)
    return None


def extract_openclaw_pin(dockerfile_path: str) -> str:
    """Read the pinned OpenClaw version from the image Dockerfile.

    The release gate parses the same literal, so the Dockerfile stays the single
    source of truth for the OpenClaw version and the Node.js line is derived
    from it instead of being pinned a second time.
    """
    path = Path(dockerfile_path)
    text = path.read_text(encoding="utf-8")
    logical = ""
    instructions: list[str] = []
    for raw_line in text.splitlines():
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
    for instruction in instructions:
        if instruction[:4].upper() != "RUN ":
            continue
        try:
            tokens = shlex.split(instruction[4:], posix=True)
        except ValueError:
            continue
        for index in range(len(tokens) - 3):
            if tokens[index:index + 3] != ["npm", "install", "-g"]:
                continue
            package, separator, pin = tokens[index + 3].rpartition("@")
            if separator and package == "openclaw":
                return pin
    raise RegistryError(f"no openclaw npm pin found in {path}")


def main(
    argv: Sequence[str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    fetch_range: Callable[[str, str, float], str] = fetch_engines_range,
    fetch_releases: Callable[[float], list[NodeRelease]] = fetch_node_releases,
) -> int:
    out = stdout or sys.stdout
    err = stderr or sys.stderr
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openclaw-version", default="", help="pinned OpenClaw version")
    parser.add_argument(
        "--dockerfile",
        default="",
        help="read the pinned OpenClaw version from this Dockerfile",
    )
    parser.add_argument(
        "--package-json",
        default="",
        help="read engines.node from this installed package.json instead of npm",
    )
    parser.add_argument("--package", default="openclaw", help="npm package that declares engines.node")
    parser.add_argument(
        "--runtime-floors",
        default="",
        help="read the secure patch floors from this installed OpenClaw package",
    )
    parser.add_argument("--engines", default="", help="use this range instead of querying npm")
    parser.add_argument("--verify", default="", help="verify an installed Node version against the range")
    parser.add_argument(
        "--no-floor",
        action="store_true",
        help="do not enforce the secure patch floor (emergency escape hatch only)",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument("--export", action="store_true", help="emit shell exports for the build")
    args = parser.parse_args(argv)

    runtime_floors: dict[str, str] | None = None
    if args.runtime_floors:
        runtime_floors = runtime_security_floors(args.runtime_floors)
        if runtime_floors is None:
            # The runtime is the single source of the secure patch floor. If
            # its table cannot be read, the floor would be silently dropped -
            # that must fail the build instead.
            print(
                f"ERROR: no secure patch floor table found in {args.runtime_floors}; "
                "the runtime is the only source of the floor, so the check is aborted.",
                file=err,
            )
            return EXIT_REGISTRY_ERROR

    range_expr = args.engines
    openclaw_version = args.openclaw_version
    if args.package_json:
        try:
            with open(args.package_json, encoding="utf-8") as handle:
                engines = (json.load(handle).get("engines") or {})
        except (OSError, json.JSONDecodeError) as error:
            print(f"ERROR: could not read {args.package_json}: {error}", file=err)
            return EXIT_REGISTRY_ERROR
        range_expr = engines.get("node") or ""
        if not range_expr:
            print(
                f"ERROR: {args.package_json} declares no engines.node range.",
                file=err,
            )
            return EXIT_REGISTRY_ERROR
    if args.dockerfile:
        try:
            openclaw_version = extract_openclaw_pin(args.dockerfile)
        except (RegistryError, OSError) as error:
            print(f"ERROR: {error}", file=err)
            return EXIT_REGISTRY_ERROR
    if not range_expr:
        if not openclaw_version:
            print(
                "ERROR: one of --engines, --package-json, --openclaw-version or --dockerfile is required.",
                file=err,
            )
            return EXIT_USAGE
        try:
            range_expr = fetch_range(args.package, openclaw_version, timeout)
        except RegistryError as error:
            print(f"ERROR: {error}", file=err)
            return EXIT_REGISTRY_ERROR

    try:
        if args.verify:
            try:
                ok = satisfies(args.verify, range_expr)
            except ValueError as error:
                print(f"ERROR: could not evaluate the range {range_expr!r}: {error}", file=err)
                return EXIT_USAGE
            if not ok:
                print(
                    f"ERROR: Node {args.verify} does not satisfy {range_expr!r}.",
                    file=err,
                )
                return EXIT_VERIFY_FAILED
            verify_floor = floor_for(args.verify.split(".")[0], runtime_floors)
            if verify_floor is None:
                print(
                    f"NOTE: the runtime declares no secure patch floor for the Node "
                    f"{args.verify.split('.')[0]}.x line; only the engine range is checked.",
                    file=err,
                )
            if (
                verify_floor
                and not args.no_floor
                and _cmp(args.verify, verify_floor) < 0
            ):
                print(
                    f"ERROR: Node {args.verify} is below the secure floor {verify_floor} "
                    "required by the OpenClaw runtime.",
                    file=err,
                )
                return EXIT_FLOOR_VIOLATION
            if args.json:
                print(json.dumps({"version": args.verify, "range": range_expr, "ok": True}))
            else:
                print(f"Node {args.verify} satisfies {range_expr}")
            return EXIT_OK

        releases = fetch_releases(timeout)
        newest, matches = select_release(
            releases,
            range_expr,
            nodesource_line_available,
            on_skip=lambda major: print(
                f"INFO: the NodeSource repository does not ship a Node {major}.x line; "
                "trying the next matching line.",
                file=err,
            ),
        )
    except RegistryError as error:
        print(f"ERROR: {error}", file=err)
        return EXIT_REGISTRY_ERROR
    except ValueError as error:
        print(
            f"ERROR: could not evaluate the range {range_expr!r}: {error}",
            file=err,
        )
        return EXIT_USAGE

    floor = floor_for(newest.major, runtime_floors)
    floor_ok = True if floor is None else _cmp(newest.version, floor) >= 0
    if not floor_ok and not args.no_floor:
        print(
            f"ERROR: the newest matching Node.js release {newest.version} is below the secure "
            f"floor {floor} required by the OpenClaw runtime. Refusing to build that image.",
            file=err,
        )
        return EXIT_FLOOR_VIOLATION
    result = {
        "package": args.package,
        "openclawVersion": openclaw_version or None,
        "range": range_expr,
        "nodeVersion": newest.version,
        "nodeMajor": newest.major,
        "nodeSourceRepo": f"node_{newest.major}.x",
        "secureFloor": floor,
        "secureFloorSatisfied": floor_ok,
        "candidates": len(matches),
    }
    if args.json:
        print(json.dumps(result, indent=2))
    elif args.export:
        print(f"export NODE_MAJOR={newest.major}")
        print(f"export NODE_VERSION={newest.version}")
        print(f"export NODE_SOURCE_REPO=node_{newest.major}.x")
        if floor is None:
            print(
                f"NOTE: the secure patch floor for the Node {newest.major}.x line is "
                "checked after the install, against the runtime's own floor table.",
                file=err,
            )
    else:
        print(f"OpenClaw {openclaw_version or ''} engines.node: {range_expr}")
        print(f"newest matching Node.js: {newest.version} (line {newest.major})")
        if floor is None:
            print(
                f"NOTE: no secure floor is known for the Node {newest.major}.x line; "
                "the runtime check remains authoritative.",
                file=err,
            )
        elif not floor_ok:
            print(
                f"WARNING: {newest.version} is below the secure floor {floor} "
                "required by the OpenClaw runtime (--no-floor overrides this).",
                file=err,
            )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
