# Contributing to IFX

## Commit messages

Commit subjects follow this format:

```text
type(scope): imperative subject
```

The scope is optional. Breaking changes may add `!` before the colon. Subjects
must be no longer than 72 characters and must not end with a period.

Accepted types are `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`,
and `ci`.

Examples:

```text
feat(viewer): add section plane controls
fix: preserve colors when isolating elements
docs: explain bundled asset mode
```

The tracked `commit-msg` hook enforces the rule. Enable it after cloning:

```bash
git config core.hooksPath .githooks
```

## Code quality

Install the development dependencies and run the same checks as CI:

```bash
python -m pip install --editable ".[dev]"
ruff format .
ruff check --fix .
ty check
pytest
```

The integration test downloads the
[VIKTOR IFC sample models](https://github.com/viktor-platform/ifc-sample-models)
directly into memory; the models do not need to be cloned or stored locally:

```bash
pytest -m integration tests/test_sample_models.py
```
