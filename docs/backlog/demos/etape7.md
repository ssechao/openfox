# Étape 7 — Démo C3 chiffrée

Exécution UTC du `2026-10-24T09:55:32Z` sur `.122`, depuis le checkout copié dans `/tmp/openfox-etape7`.

SHA testé : `e6aca4ce2ce6c5cffa2b917600e001152c94655c`

```bash
docker --context pve8 run --rm --user node -v /tmp/openfox-etape7:/work -w /work node:24-bookworm npx tsx scripts/demo-etape7.ts
```

Sortie complète exacte (stdout + stderr) :

```text
Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.
/work/scripts/demo-etape7.ts:233
      reject(new Error(`Observer exited before ${label}: code=${code} signal=${signal}`))
             ^

Error: Observer exited before externally received witness completion: code=0 signal=null
    at ChildProcess.onExit (/work/scripts/demo-etape7.ts:233:14)
    at ChildProcess.emit (node:events:526:24)
    at ChildProcess._handle.onexit (node:internal/child_process:295:12)

Node.js v24.21.0
npm notice
npm notice New major version of npm available! 11.19.0 -> 12.2.1
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.1
npm notice To update run: npm install -g npm@12.2.1
npm notice
```

Code de sortie : `1`.
