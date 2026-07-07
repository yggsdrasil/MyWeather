# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single **Angular 9.1** single-page app named `myweather` (package manager: **npm**, lockfile `package-lock.json`). There is no backend/database — only the Angular dev server is needed to run it. Standard commands live in `package.json` and `README.md`.

### Node version (important)
- The Angular 9.1 toolchain requires **Node 14** (Node 16+ breaks `@angular-devkit/build-angular@0.901`). Node 14 is installed via `nvm` and set as the default alias, so new shells already resolve to it (`node --version` → `v14.x`). The base image also exposes a Node 22 binary at `/exec-daemon/node`, but nvm's default puts Node 14 ahead of it in `PATH`. If a shell ever shows Node 22, run `nvm use 14`.

### Running / testing (non-obvious caveats)
- Dev server: `npm start` (serves at `http://localhost:4200/`). Use `npm start -- --host 0.0.0.0` if you need to reach it from outside the VM. Hot reload works on `src/` edits.
- Unit tests: `karma.conf.js` defaults to the `Chrome` launcher, which fails headless. Run tests headless with:
  `CHROME_BIN=$(which google-chrome) npm test -- --watch=false --browsers=ChromeHeadless`
  (ChromeHeadless works without `--no-sandbox` in this VM.)
- Lint: `npm run lint`. Build: `npm run build` (output → `dist/myweather`).
- E2E (`npm run e2e`, Protractor) needs a matching chromedriver for the installed Chrome; not required for normal development.
