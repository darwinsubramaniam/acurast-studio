# Release Guide

There are three release types, all driven by `.github/workflows/publish.yml`.

---

## RC (Release Candidate)

Use this to produce a testable `.vsix` for internal review without touching the Marketplace.

**Steps:**

1. Bump `version` in `package.json` if needed, commit and push to `main`.
2. Go to **Actions → Publish Extension → Run workflow**.
3. Select `rc` and click **Run workflow**.

**What happens:**
- Lints, typechecks, and packages `acurast-studio.vsix`.
- Creates a **draft** GitHub Release tagged `v{version}-rc.{run_number}` (e.g. `v0.2.1-rc.5`).
- Attaches the `.vsix` to the release as a downloadable asset.
- Nothing is published to the VS Code Marketplace.

**To install the RC locally:**
Download the `.vsix` from the draft release and run:
```bash
code --install-extension acurast-studio.vsix
```

---

## Pre-release (Marketplace Preview)

Use this to publish a preview version directly to the VS Code Marketplace. Users who opt in to pre-releases will receive it automatically.

**Steps:**

1. Bump `version` in `package.json` to an odd minor (VS Code Marketplace convention for pre-releases, e.g. `0.3.0`), commit and push to `main`. *(Optional but recommended.)*
2. Ensure the `VSCE_PAT` secret is set in the repository settings.
3. Go to **Actions → Publish Extension → Run workflow**.
4. Select `pre-release` and click **Run workflow**.

**What happens:**
- Lints, typechecks, and packages `acurast-studio-prerelease.vsix` with `--pre-release`.
- Publishes directly to the VS Code Marketplace as a **Preview** version.
- No GitHub Release is created.

---

## Stable Release

Use this to publish the official production version to the VS Code Marketplace.

**Steps:**

1. Bump `version` in `package.json` to the final version (e.g. `0.2.1`), commit and push to `main`.
2. Ensure the `VSCE_PAT` secret is set in the repository settings.
3. Create and push a version tag:
   ```bash
   git tag v0.2.1
   git push origin v0.2.1
   ```

**What happens:**
- The tag push triggers the workflow automatically (no manual dispatch needed).
- Lints, typechecks, and packages `acurast-studio.vsix`.
- Creates a **published** GitHub Release for the tag with auto-generated release notes and the `.vsix` attached.
- Publishes to the VS Code Marketplace as a **stable** version.

---

## Summary

| Type | Trigger | Marketplace | GitHub Release |
|---|---|---|---|
| RC | Manual (`workflow_dispatch` → `rc`) | No | Draft |
| Pre-release | Manual (`workflow_dispatch` → `pre-release`) | Yes (Preview) | No |
| Stable | Push tag `v*` | Yes (Stable) | Published |

---

## Required secret

`VSCE_PAT` — a Personal Access Token from the [Visual Studio Marketplace publisher portal](https://marketplace.visualstudio.com/manage). Required for pre-release and stable publishes. Not needed for RC.
