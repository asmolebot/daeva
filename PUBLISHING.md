# Publishing Daeva

## Prepublish checklist

- [ ] All tests pass: `npm test`
- [ ] Build succeeds: `npm run build`
- [ ] Typecheck passes: `npm run typecheck`
- [ ] `npm pack --dry-run` looks correct (no extra files, no missing files)
- [ ] `package.json` version is updated
- [ ] README.md is current
- [ ] LICENSE file exists at project root
- [ ] CHANGELOG or release notes prepared (if applicable)
- [ ] Git working tree is clean
- [ ] Git tag matches package version

## Quick sanity check

```bash
./scripts/release-check.sh
```

## npm publish

```bash
# Dry run first
npm publish --dry-run

# Publish for real
npm publish

# If scoped and public:
# npm publish --access public
```

### First-time setup

```bash
npm login
npm whoami   # verify
```

## Git tagging

```bash
git tag v$(node -p "require('./package.json').version")
git push origin --tags
```

## Curl installer hosting (asmo.bot)

The install scripts in `scripts/` are designed to be hosted at:

- `https://asmo.bot/install-linux.sh`
- `https://asmo.bot/install-macos.sh`
- `https://asmo.bot/install-windows.ps1`

To set this up:
1. Host the scripts behind a static file server or CDN at asmo.bot
2. Ensure the scripts are served with correct content types (`text/plain` for `.sh`, `text/plain` for `.ps1`)
3. The scripts detect whether they're in a local source tree or should install from npm — when served remotely they'll `npm install -g daeva`

## ClaWHub skill packaging notes

When packaging Daeva as a ClaWHub skill:
- The MCP server binary (`daeva-mcp`) is the integration point
- Skill config should point at `daeva-mcp --base-url <url>`
- The orchestrator server (`daeva`) runs separately as a background service
- Skill metadata should reference the npm package name `daeva`
- Consider shipping a minimal skill manifest that auto-starts the server if not already running
