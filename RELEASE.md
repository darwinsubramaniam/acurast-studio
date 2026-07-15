# Release Guide

Releases are **100% tag-driven**. You never hand-edit the version in
`package.json` — the git tag is the single source of truth for both the
**channel** (rc / pre-release / stable) and the **version**. CI rewrites
`package.json` to match the tag before packaging.

Push a tag → the right thing happens. That's the whole workflow.

```bash
git tag v0.4.0-rc.1 && git push origin v0.4.0-rc.1   # release candidate
git tag v0.5.0-pre  && git push origin v0.5.0-pre     # marketplace preview
git tag v0.6.0      && git push origin v0.6.0          # stable release
```

---

## How the tag maps to a release

| Git tag         | Channel      | `package.json` becomes | Marketplace          | GitHub Release        |
|-----------------|--------------|------------------------|----------------------|-----------------------|
| `v0.4.0-rc.1`   | RC           | `0.4.0`                | ❌ not published      | Draft (pre-release)   |
| `v0.5.0-pre`    | Pre-release  | `0.5.0`                | ✅ Preview (`--pre-release`) | Published (pre-release) |
| `v0.6.0`        | Stable       | `0.6.0`                | ✅ Stable             | Published + notes     |

The Marketplace **rejects any pre-release suffix in the version field** — a
version must be strictly `major.minor.patch`. So the `-rc.N` / `-pre` suffix
lives only in the git tag; CI strips it to derive the numeric version that goes
into the `.vsix`.

Because that suffix is gone from the packaged version, the extension can't tell
a pre-release from a stable build at runtime from the number alone (and VS Code
exposes no pre-release flag to extensions). So the same "Parse Tag" step also
stamps the channel + full tag into the manifest — `npm pkg set
acurastRelease.channel=… acurastRelease.tag=…` — which `extension.ts` reads back
to drive the version badge on the Studio Home view (a "Pre-release" / "RC" pill
for non-stable builds). It's written in CI only, never committed.

---

## Versioning convention (odd-minor)

The Marketplace won't serve a pre-release and a stable that share the same
version number — a pre-release must be a *higher* version than the latest
stable. We follow Microsoft's recommended scheme to keep the channels apart:

- **Stable** → even minor: `0.4.0`, `0.6.0`, `0.8.0`, …
- **Pre-release** → next odd minor: `0.5.0`, `0.7.0`, `0.9.0`, …

So the lifecycle of an upcoming release looks like:

```bash
git tag v0.5.0-rc.1 && git push origin v0.5.0-rc.1   # test the .vsix internally
git tag v0.5.0-pre  && git push origin v0.5.0-pre     # ship to preview channel
git tag v0.6.0      && git push origin v0.6.0          # promote to stable
```

CI emits a **warning** (never a hard failure) if you tag a stable with an odd
minor or a pre-release with an even minor — so you can deviate if you ever need
to, but you'll be reminded.

---

## RC (Release Candidate)

A testable `.vsix` for internal review without touching the Marketplace.

```bash
git tag v0.4.0-rc.1 && git push origin v0.4.0-rc.1
```

- Lints, typechecks, and packages `acurast-studio.vsix` as version `0.4.0`.
- Creates a **draft, pre-release** GitHub Release for the tag with the `.vsix` attached.
- Nothing is published to the Marketplace.

Install it locally — download the `.vsix` from the draft release, then:

```bash
code --install-extension acurast-studio.vsix
```

Iterate by bumping the rc counter: `v0.4.0-rc.2`, `v0.4.0-rc.3`, …

---

## Pre-release (Marketplace Preview)

Publishes a preview version to the Marketplace. Users who opt in to pre-releases
receive it automatically.

```bash
git tag v0.5.0-pre && git push origin v0.5.0-pre
```

- Packages with `--pre-release` as version `0.5.0` (use the odd minor).
- Publishes the exact built artifact to the Marketplace **Preview** channel.
- Creates a **published, pre-release** GitHub Release with auto-generated notes and the `.vsix` attached.

Requires the `VSCE_PAT` secret (see below).

---

## Stable Release

Publishes the official production version to the Marketplace.

```bash
git tag v0.6.0 && git push origin v0.6.0
```

- Packages `acurast-studio.vsix` as version `0.6.0` (use the even minor).
- Publishes the exact built artifact to the Marketplace as **stable**.
- Creates a **published** GitHub Release with auto-generated notes and the `.vsix` attached.

Requires the `VSCE_PAT` secret (see below).

---

## Notes

- **No manual "Run workflow" button.** `workflow_dispatch` was removed — every
  release is a tag. CI (`.github/workflows/ci.yml`) already runs the full
  lint + typecheck + build + test suite on every push to `main` and on PRs, so
  tag your release commit after CI is green on `main`.
- **CI does not commit the version bump back.** The `package.json` rewrite is
  ephemeral (CI workspace only). Your committed `version` is just a dev default;
  the tag overrides it at build time. Keep `version` in `package.json` roughly
  in sync for sanity, but it is not authoritative.
- **Re-tagging.** If you need to redo a release, delete the tag locally and
  remotely (`git tag -d v0.6.0 && git push origin :refs/tags/v0.6.0`) and push a
  new one. You cannot re-publish the same version to the Marketplace.

---

## Required secret

`VSCE_PAT` — a Personal Access Token from the
[Visual Studio Marketplace publisher portal](https://marketplace.visualstudio.com/manage).
Required for pre-release and stable publishes. Not needed for RC.
