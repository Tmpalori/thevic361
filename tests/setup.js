// The server falls back to GITHUB_TOKEN / GITHUB_PAT from the environment.
// Dev containers and some CI runners export one, which flips the "GitHub not
// configured" paths these tests exercise. Tests that need GitHub pass a
// token explicitly through createApp options.
delete process.env.GITHUB_TOKEN;
delete process.env.GITHUB_PAT;
delete process.env.GH_TOKEN;
