import { describe, it, expect } from 'vitest';
import { parseDistroPlugin, v4TagsNewestFirst, fetchDistroCatalog } from '../../sdk/distroFetch';

const UBUNTU = `# This is a default distribution plug-in.
DISTRO_NAME="Ubuntu (25.10)"
DISTRO_COMMENT="Regular release (questing)."

TARBALL_URL['aarch64']="https://easycli.sh/proot-distro/ubuntu-questing-aarch64-pd-v4.37.0.tar.xz"
TARBALL_SHA256['aarch64']="37e61ce5fd8593a7d10c4e72ebe611adb7e795f7492e4c0bf3a950441c984161"
TARBALL_URL['arm']="https://easycli.sh/proot-distro/ubuntu-questing-arm-pd-v4.37.0.tar.xz"
TARBALL_SHA256['arm']="b074efe535b565f426219f20b35af0c4a7b3d0bc18ebd4fa11ccbd7370315b53"
TARBALL_URL['x86_64']="https://easycli.sh/proot-distro/ubuntu-questing-x86_64-pd-v4.37.0.tar.xz"
TARBALL_SHA256['x86_64']="74f7c8492a2f3e720d5aa89de6572cbb90b14c4b21dee87ab33416b6fb1088c3"

distro_setup() {
	sed -i -E 's/#[[:space:]]?(en_US.UTF-8[[:space:]]+UTF-8)/\\1/g' ./etc/locale.gen
}
`;

describe('parseDistroPlugin', () => {
  it('extracts the aarch64 image, ignoring the other architectures', () => {
    expect(parseDistroPlugin('ubuntu', UBUNTU)).toEqual({
      id: 'ubuntu',
      name: 'Ubuntu (25.10)',
      comment: 'Regular release (questing).',
      url: 'https://easycli.sh/proot-distro/ubuntu-questing-aarch64-pd-v4.37.0.tar.xz',
      sha256: '37e61ce5fd8593a7d10c4e72ebe611adb7e795f7492e4c0bf3a950441c984161',
    });
  });

  it('omits comment when the plugin declares none', () => {
    const src = `DISTRO_NAME="Void Linux"
TARBALL_URL['aarch64']="https://x.test/void.tar.xz"
TARBALL_SHA256['aarch64']="37e61ce5fd8593a7d10c4e72ebe611adb7e795f7492e4c0bf3a950441c984161"`;
    expect(parseDistroPlugin('void', src)).toEqual({
      id: 'void',
      name: 'Void Linux',
      url: 'https://x.test/void.tar.xz',
      sha256: '37e61ce5fd8593a7d10c4e72ebe611adb7e795f7492e4c0bf3a950441c984161',
    });
  });

  it('falls back to the plugin id when DISTRO_NAME is missing', () => {
    const src = `TARBALL_URL['aarch64']="https://x.test/a.tar.xz"
TARBALL_SHA256['aarch64']="37e61ce5fd8593a7d10c4e72ebe611adb7e795f7492e4c0bf3a950441c984161"`;
    expect(parseDistroPlugin('mystery', src)?.name).toBe('mystery');
  });

  it('rejects a malformed SHA256 (not 64 hex chars) rather than trusting it', () => {
    const short = `DISTRO_NAME="Bad"
TARBALL_URL['aarch64']="https://x.test/bad.tar.xz"
TARBALL_SHA256['aarch64']="abc"`;
    expect(parseDistroPlugin('bad', short)).toBeNull();

    const nonHex = `DISTRO_NAME="Bad"
TARBALL_URL['aarch64']="https://x.test/bad.tar.xz"
TARBALL_SHA256['aarch64']="zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"`;
    expect(parseDistroPlugin('bad', nonHex)).toBeNull();
  });

  it('rejects a plugin with no aarch64 entry (arm-only)', () => {
    const src = `DISTRO_NAME="Old"
TARBALL_URL['arm']="https://x.test/old.tar.xz"
TARBALL_SHA256['arm']="abc"`;
    expect(parseDistroPlugin('old', src)).toBeNull();
  });

  it('rejects termux.sh — a .zip bootstrap is not a .tar.xz rootfs', () => {
    const src = `DISTRO_NAME="Termux"
TARBALL_URL['aarch64']="https://github.com/termux/termux-packages/releases/download/x/bootstrap-aarch64.zip"
TARBALL_SHA256['aarch64']="bec3e2b674b6efee7ff0e2a12824eb376e3fe182cc424d3357dad72c7cdd20d5"`;
    expect(parseDistroPlugin('termux', src)).toBeNull();
  });

  it('rejects the sample plugin, which declares no tarball at all', () => {
    expect(parseDistroPlugin('distro.sh', '# TARBALL_URL[\'aarch64\']=""\n')).toBeNull();
  });
});

describe('v4TagsNewestFirst', () => {
  it('sorts numerically, not lexically (v4.38 > v4.9)', () => {
    expect(v4TagsNewestFirst(['v4.9.0', 'v4.38.0', 'v4.36.0'])).toEqual(['v4.38.0', 'v4.36.0', 'v4.9.0']);
  });

  it('orders by patch when minors tie', () => {
    expect(v4TagsNewestFirst(['v4.34.1', 'v4.34.2'])).toEqual(['v4.34.2', 'v4.34.1']);
  });

  it('drops v5 tags — that line ships no .tar.xz rootfs', () => {
    expect(v4TagsNewestFirst(['v5.4.1', 'v5.0.2', 'v4.38.0'])).toEqual(['v4.38.0']);
  });

  it('returns empty when upstream has no v4 tags', () => {
    expect(v4TagsNewestFirst(['v5.4.1', 'random'])).toEqual([]);
  });
});

// A fake GitHub: tags → plugin dir listing → plugin bodies. Lets us assert the
// two-group behaviour (current + newest-still-on-GitHub) without network.
function fakeGitHub(pluginsByTag: Record<string, Record<string, string>>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    });

    if (url.includes('/tags')) return ok(Object.keys(pluginsByTag).map((name) => ({ name })));

    const dir = url.match(/contents\/distro-plugins\?ref=(.+)$/);
    if (dir) {
      const tag = dir[1];
      return ok(
        Object.keys(pluginsByTag[tag] ?? {}).map((name) => ({
          name,
          download_url: `https://raw.example/${tag}/${name}`,
        })),
      );
    }

    const raw = url.match(/(?:raw\.example|raw\.githubusercontent\.com\/termux\/proot-distro)\/([^/]+)\/(?:distro-plugins\/)?(.+)$/);
    if (raw) {
      const body = pluginsByTag[raw[1]]?.[raw[2]];
      if (body === undefined) return { ok: false, status: 404, statusText: 'Not Found' };
      return ok(body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function plugin(name: string, host: string, tag: string): string {
  return `DISTRO_NAME="${name}"
TARBALL_URL['aarch64']="https://${host}/${name.toLowerCase()}-aarch64-pd-${tag}.tar.xz"
TARBALL_SHA256['aarch64']="${'0'.repeat(64)}"`;
}

describe('fetchDistroCatalog', () => {
  it('offers the newest images plus the newest still-on-GitHub ones', async () => {
    const catalog = await fetchDistroCatalog(
      fakeGitHub({
        'v5.4.1': {},
        'v4.38.0': { 'ubuntu.sh': plugin('Ubuntu', 'easycli.sh', 'v4.37.0') },
        'v4.37.0': { 'ubuntu.sh': plugin('Ubuntu', 'easycli.sh', 'v4.37.0') },
        'v4.36.0': { 'ubuntu.sh': plugin('Ubuntu', 'github.com', 'v4.34.2') },
      }),
    );

    expect(catalog.groups.map((g) => [g.tag, g.host])).toEqual([
      ['v4.38.0', 'easycli.sh'],
      ['v4.36.0', 'github.com'],
    ]);
    expect(catalog.groups[0].label).toBe('Current (v4.38.0)');
    expect(catalog.groups[1].label).toBe('GitHub-hosted (v4.36.0)');
  });

  it('returns a single group when the newest images are already on GitHub', async () => {
    const catalog = await fetchDistroCatalog(
      fakeGitHub({ 'v4.36.0': { 'ubuntu.sh': plugin('Ubuntu', 'github.com', 'v4.34.2') } }),
    );
    expect(catalog.groups).toHaveLength(1);
    expect(catalog.groups[0].host).toBe('github.com');
  });

  it('throws when upstream has no v4 tag left to read', async () => {
    await expect(fetchDistroCatalog(fakeGitHub({ 'v5.4.1': {} }))).rejects.toThrow(/No v4\.x tag/);
  });

  it('throws when a v4 tag yields no aarch64 images', async () => {
    const catalog = fetchDistroCatalog(
      fakeGitHub({ 'v4.38.0': { 'termux.sh': `DISTRO_NAME="Termux"\nTARBALL_URL['aarch64']="https://x/b.zip"\nTARBALL_SHA256['aarch64']="a"` } }),
    );
    await expect(catalog).rejects.toThrow(/No aarch64 images/);
  });
});
