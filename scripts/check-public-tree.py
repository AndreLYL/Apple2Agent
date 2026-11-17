#!/usr/bin/env python3
"""Check publication files without ever printing matched private values.

This complements a secret scanner; it is not a proof of absence of secrets.
Scans tracked files and non-ignored untracked files, not runtime directories.
"""
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
names = subprocess.check_output(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    cwd=ROOT,
).decode().split("\0")
rules = {
    "personal-home-path": re.compile(r"(?<![A-Za-z0-9.])/(?:Users|home)/[A-Za-z0-9_.-]+"),
    "signed-resource-reference": re.compile(r"a2a1\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}"),
    "private-tunnel-id": re.compile(r"tunnel_[a-fA-F0-9]{24,}"),
}
email = re.compile(r"[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})")
allowed_domains = {"example.com", "example.org", "example.net", "users.noreply.github.com"}
blocked_parts = {"node_modules", "dist", "bin", "work", "outputs", "backups", "connector", ".ssh"}
blocked_suffixes = {".sqlite", ".sqlite3", ".db", ".pem", ".p12", ".pfx", ".key", ".log", ".zip", ".png", ".jpg"}
blocked_names = {"config.json", "connector.json", "runtime-key", ".env", ".DS_Store"}
# Manually reviewed synthetic images; any content change requires a new review and hash.
reviewed_binaries = {
    "docs/assets/hero.png": "a483d8361bb1948dc60a649614a669b4a2499cc0c8caf191309aff033b934b1c",
    "docs/assets/hero.zh-CN.png": "7e68c24676a0bb390bba05ba94f30aecc9ee475a52e1c06978b23e6468230a59",
}
findings = []
count = 0
for name in sorted(set(filter(None, names))):
    path = ROOT / name
    if not path.exists():
        continue
    count += 1
    if path.is_symlink():
        findings.append({"file": name, "rule": "symlink-requires-review"})
        continue
    rel = Path(name)
    if reviewed_binaries.get(name) == hashlib.sha256(path.read_bytes()).hexdigest():
        continue
    if blocked_parts.intersection(rel.parts) or rel.suffix.lower() in blocked_suffixes or rel.name in blocked_names or rel.name.startswith(".env."):
        findings.append({"file": name, "rule": "private-or-generated-file"})
    try:
        content = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        findings.append({"file": name, "rule": "non-text-file-requires-review"})
        continue
    for line_no, line in enumerate(content.splitlines(), 1):
        for rule, pattern in rules.items():
            if pattern.search(line):
                findings.append({"file": name, "line": line_no, "rule": rule})
        if any(m.group(1).lower() not in allowed_domains for m in email.finditer(line)):
            findings.append({"file": name, "line": line_no, "rule": "non-example-email"})
print(json.dumps({"files_checked": count, "findings": findings}, indent=2))
raise SystemExit(1 if findings else 0)
