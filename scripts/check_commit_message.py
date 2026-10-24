#!/usr/bin/env python3
"""Validate IFX commit subjects against the repository convention."""

import re
import sys
from pathlib import Path

ALLOWED_TYPES = ("feat", "fix", "refactor", "chore", "docs", "test", "perf", "ci")
SUBJECT_PATTERN = re.compile(rf"^({'|'.join(ALLOWED_TYPES)})(\([a-z0-9][a-z0-9._/-]*\))?!?: .+$")
AUTOMATED_PREFIXES = ("Merge ", "Revert ", "fixup! ", "squash! ")


def validate_subject(subject: str) -> list[str]:
    """Return validation errors for the first line of a commit message."""

    errors: list[str] = []
    if subject.startswith(AUTOMATED_PREFIXES):
        return errors
    if len(subject) > 72:
        errors.append("subject must be 72 characters or fewer")
    if not SUBJECT_PATTERN.fullmatch(subject):
        errors.append("subject must match: type(scope): subject")
    if subject.endswith("."):
        errors.append("subject must not end with a period")
    return errors


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: check_commit_message.py <commit-message-file>", file=sys.stderr)
        return 2

    lines = Path(args[0]).read_text(encoding="utf-8").splitlines()
    subject = next(
        (line.strip() for line in lines if line.strip() and not line.startswith("#")), ""
    )
    errors = validate_subject(subject)
    if not errors:
        return 0

    print("Invalid commit message:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    print(f"Allowed types: {', '.join(ALLOWED_TYPES)}", file=sys.stderr)
    print("Example: feat(viewer): add section plane controls", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
