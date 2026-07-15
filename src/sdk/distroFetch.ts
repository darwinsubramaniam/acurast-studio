// Reads the proot-distro image catalog (rootfs URL + SHA256 per distro) that
// backs the Shell runtime's image picker.
//
// Source of truth is `distro-plugins/<id>.sh` in termux/proot-distro. Each file
// declares, per architecture, exactly the two values acurast.json needs:
//
//   DISTRO_NAME="Ubuntu (25.10)"
//   TARBALL_URL['aarch64']="https://easycli.sh/proot-distro/ubuntu-questing-aarch64-pd-v4.37.0.tar.xz"
//   TARBALL_SHA256['aarch64']="37e61ce5fd8593a7d10c4e72ebe611adb7e795f7492e4c0bf3a950441c984161"
//
// Three properties of upstream drive the design here:
//
//  1. Tarballs are pinned PER DISTRO, not per release — at v4.38.0 Ubuntu points
//     at a v4.37.0 build while other distros point further back — so the catalog
//     cannot be derived by listing one release's assets. The plugin files at a
//     tag are the manifest.
//  2. Only the v4 line still publishes a *catalog*. The v5 rewrite dropped the
//     bundled distro list entirely — `proot-distro install` now takes a Docker
//     image ref, a plain URL, or a local archive — so v5 tags have no
//     `distro-plugins/` directory. The maintainer does mirror v5 rootfs tarballs
//     (easycli.sh/proot-distro/v5.0.0/), but publishes NO SHA256 for them: v5
//     never verifies a hash, so it doesn't need one. Acurast does. That makes the
//     v4 plugin files the only upstream source pinning URL and SHA256 together,
//     so we resolve the newest v4.x tag rather than the newest tag.
//  3. As of v4.37.0 the tarballs are no longer hosted on GitHub releases — the
//     maintainer migrated downloads to their own host (commit 7bfb52c7,
//     "migrate downloads to own hosting"). Both sets remain valid and the
//     processor verifies the pinned SHA256 either way, so we surface the newest
//     images AND the newest still-on-GitHub ones as two groups and let the user
//     choose. See findGithubTag.
//
// This module is deliberately dependency-free (no vscode, no node builtins) so
// both the extension host and `scripts/build-distros.mjs` can use it.

import type { DistroCatalog, DistroGroup, DistroImage } from '../studio/types';

const REPO = 'termux/proot-distro';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}`;
/** Acurast processors are Android ARM64 devices; no other arch can run there. */
const ARCH = 'aarch64';
const PLUGIN_DIR = 'distro-plugins';
const GITHUB_HOST = 'github.com';
/** Any plugin would do to sniff a tag's download host; ubuntu is always present. */
const PROBE_PLUGIN = 'ubuntu';
/** How far back to walk looking for the last GitHub-hosted tag before giving up. */
const PROBE_LIMIT = 10;
/** GitHub rejects API requests without a User-Agent. */
const HEADERS: Record<string, string> = {
  'User-Agent': 'acurast-studio',
  Accept: 'application/vnd.github+json',
};

/** Only v4 tags carry `.tar.xz` rootfs (see header note). */
const V4_TAG_RE = /^v4\.(\d+)\.(\d+)$/;

function quoted(source: string, pattern: RegExp): string | undefined {
  const m = source.match(pattern);
  return m ? m[1].trim() : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Parse one `distro-plugins/<id>.sh` into its aarch64 image, or null when the
 * plugin has no usable one — `distro.sh.sample` (a template with no tarball) and
 * `termux.sh` (a `.zip` bootstrap, not a `.tar.xz` rootfs) both drop out here.
 */
/** A SHA256 digest is exactly 64 hex characters. */
const SHA256_RE = /^[a-f0-9]{64}$/i;

export function parseDistroPlugin(id: string, source: string): DistroImage | null {
  const url = quoted(source, new RegExp(`TARBALL_URL\\['${ARCH}'\\]="([^"]+)"`));
  const sha256 = quoted(source, new RegExp(`TARBALL_SHA256\\['${ARCH}'\\]="([^"]+)"`));
  // Reject a missing/malformed integrity hash rather than letting a truncated or
  // tampered value flow into acurast.json — the processor verifies this SHA256 on
  // download, so it is the one integrity control in the image pipeline.
  if (!url || !sha256 || !url.endsWith('.tar.xz') || !SHA256_RE.test(sha256)) return null;

  const name = quoted(source, /^DISTRO_NAME="([^"]*)"/m) || id;
  const comment = quoted(source, /^DISTRO_COMMENT="([^"]*)"/m);
  return comment ? { id, name, comment, url, sha256 } : { id, name, url, sha256 };
}

/** v4 tags, newest first. Non-v4 tags (the v5 line) are dropped. */
export function v4TagsNewestFirst(tagNames: string[]): string[] {
  return tagNames
    .map((t) => ({ tag: t, m: V4_TAG_RE.exec(t) }))
    .filter((e): e is { tag: string; m: RegExpExecArray } => e.m !== null)
    .sort((a, b) => Number(b.m[1]) - Number(a.m[1]) || Number(b.m[2]) - Number(a.m[2]))
    .map((e) => e.tag);
}

async function getText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  return JSON.parse(await getText(url, fetchImpl)) as T;
}

/** Every aarch64 image declared at `tag`, sorted by display name. */
async function fetchImagesAt(tag: string, fetchImpl: typeof fetch): Promise<DistroImage[]> {
  const entries = await getJson<Array<{ name: string; download_url: string | null }>>(
    `${API}/contents/${PLUGIN_DIR}?ref=${tag}`,
    fetchImpl,
  );
  const images = await Promise.all(
    entries
      .filter((e) => e.name.endsWith('.sh') && e.download_url)
      .map(async (e) =>
        parseDistroPlugin(e.name.replace(/\.sh$/, ''), await getText(e.download_url!, fetchImpl)),
      ),
  );
  return images
    .filter((d): d is DistroImage => d !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Walk back from the newest tags to find the last one whose tarballs are still
 * hosted on GitHub. Probes a single plugin file per tag over raw.githubusercontent
 * (not API-rate-limited) and stops at the first hit, so the common case costs one
 * request. Returns null if none of the probed tags qualify.
 */
async function findGithubTag(tags: string[], fetchImpl: typeof fetch): Promise<string | null> {
  for (const tag of tags.slice(0, PROBE_LIMIT)) {
    try {
      const src = await getText(`${RAW}/${tag}/${PLUGIN_DIR}/${PROBE_PLUGIN}.sh`, fetchImpl);
      const img = parseDistroPlugin(PROBE_PLUGIN, src);
      if (img && hostOf(img.url) === GITHUB_HOST) return tag;
    } catch {
      // A tag that predates the plugin (or a transient failure) just isn't a
      // candidate — keep walking rather than failing the whole refresh.
    }
  }
  return null;
}

function toGroup(label: string, tag: string, distros: DistroImage[]): DistroGroup {
  return { label, tag, host: hostOf(distros[0].url), distros };
}

/**
 * Fetch the current aarch64 catalog from GitHub: the newest v4 tag's images, plus
 * the newest GitHub-hosted images when upstream has since moved hosting elsewhere.
 *
 * Costs a handful of GitHub API calls (the unauthenticated limit is 60/hour) plus
 * one raw.githubusercontent request per plugin file, which is not API-rate-limited.
 *
 * Throws on network failure or a rate-limited API — callers surface that as an
 * inline error and keep showing the catalog they already had.
 */
export async function fetchDistroCatalog(fetchImpl: typeof fetch = fetch): Promise<DistroCatalog> {
  const tags = await getJson<Array<{ name: string }>>(`${API}/tags?per_page=100`, fetchImpl);
  const v4 = v4TagsNewestFirst(tags.map((t) => t.name));
  if (!v4.length) throw new Error(`No v4.x tag found in ${REPO} — upstream layout changed`);

  const current = v4[0];
  const currentImages = await fetchImagesAt(current, fetchImpl);
  if (!currentImages.length) {
    throw new Error(`No ${ARCH} images found at ${current} — upstream layout changed`);
  }
  const groups: DistroGroup[] = [toGroup(`Current (${current})`, current, currentImages)];

  // Only look for a GitHub-hosted fallback when the newest images aren't already
  // on GitHub — if upstream ever moves back, one group is the honest answer.
  if (hostOf(currentImages[0].url) !== GITHUB_HOST) {
    const ghTag = await findGithubTag(v4.slice(1), fetchImpl);
    if (ghTag) {
      const ghImages = await fetchImagesAt(ghTag, fetchImpl);
      if (ghImages.length) groups.push(toGroup(`GitHub-hosted (${ghTag})`, ghTag, ghImages));
    }
  }

  return { fetchedAt: new Date().toISOString(), groups };
}
