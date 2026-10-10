// The server falls back to GITHUB_TOKEN / GITHUB_PAT from the environment.
// Dev containers and some CI runners export one, which flips the "GitHub not
// configured" paths these tests exercise. Tests that need GitHub pass a
// token explicitly through createApp options.
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_PAT;
delete process.env.GH_TOKEN;

// Node 25 ships its own global localStorage/sessionStorage, which have no
// methods unless node runs with --localstorage-file, and they shadow jsdom's.
// Point the globals back at jsdom's working Storage so admin/app tests run
// the same on Node 25 as on CI's Node 22.
if (globalThis.jsdom && typeof globalThis.localStorage?.setItem !== 'function') {
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, {
      configurable: true, enumerable: true, get: () => globalThis.jsdom.window[name]
    });
  }
}

// The legal pages' business identity (server/legal.js) comes from these;
// a developer's shell that exports one would change every page's text.
delete process.env.BUSINESS_LEGAL_NAME;
delete process.env.BUSINESS_CONTACT_EMAIL;
