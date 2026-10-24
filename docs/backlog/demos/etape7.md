# Étape 7 — Démo C3 chiffrée

## Diagnostic 7d — blocages gateway et orphelin

Profilage sur `.122` du code applicatif `6d5c2b5b` avec `node --cpu-prof` et une sonde de retard de boucle à 20 ms. Les blocages horodatés coïncident avec les charges réelles : jusqu’à 944 ms pendant le diff/stdout, puis 802 ms lors de la récupération après SIGKILL. Sur 39 358 échantillons gateway, les principaux postes non idle sont `express`/`JSON.stringify` (1 695), GC (1 318), décodage des lignes EventStore (`rowToStoredEvent`, 759 sur les entrées sourcemap dupliquées), puis encodage/décodage UTF-8. Git, l’extraction PDF et la capture stdout s’exécutent bien dans le worker; ils ne sont pas dans les piles chaudes gateway.

Cause performance : chaque fragment `tool.output` des 56 Mio de diff et 64 Mio de stdout est persisté, relayé worker → superviseur → gateway, puis diffusé en WS sans budget serveur. Les lectures de session replient ensuite ce journal intégral dans `streamingOutput` et `res.json` le sérialise, bien que le résultat final soit borné à 50 Kio. Le profil montre les deux rafales `rowToStoredEvent`/`stringify`/GC pendant le relais puis lors de la lecture finale de la session perturbatrice. L’écriture SQLite synchrone reste dans le worker et le PDF ne produit pas de gros relais : ce ne sont pas les causes du blocage gateway observé.

Cause orphelin : le nettoyage envoie bien SIGTERM/SIGKILL au groupe enregistré. Une reproduction minimale dans le même conteneur laisse toutefois le descendant tué en état Linux `Z`, `PPID=1`, avec son PGID encore visible; le PID 1 du conteneur ne le réape pas. `readProcessInventory` et `kill(-pgid, 0)` classent ce zombie non exécutable comme vivant, et aucun signal supplémentaire ne peut le faire disparaître. Le nettoyage doit donc garantir le réapage par un ancêtre responsable, pas répéter le kill ni masquer silencieusement l’état.

## Rejeu final

Exécution UTC du `2026-10-24T13:59:38Z` sur `.122`, depuis le checkout copié dans `/tmp/openfox-etape7`.

SHA testé : `e7aa628e0997ab270064e99cb4fc1c1cd7c02508`

```bash
docker --context pve8 run --rm --user node -v /tmp/openfox-etape7:/work -w /work node:24-bookworm sh -c 'npx tsx scripts/demo-etape7.ts 2>&1'
```

Sortie complète exacte (stdout + stderr) :

```text
Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.
[2026-10-24T13:59:38.144Z] [ERROR] Session worker died {"sessionId":"d80fced9-a759-4787-98ee-608af4c8dc5e","workerId":"35dee2dd-0be5-471b-89fa-7bee6ed5c78c","generation":1,"exitCode":null,"signal":"SIGKILL","stderr":["Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.","Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.","Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.","Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.","Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided."]}
RÉSUMÉ CHIFFRÉ — Étape 7 C3
PASS C3.1 isolation/pool — revision=e7aa628e0997ab270064e99cb4fc1c1cd7c02508 db_temp=true port=37259 pool=2 gateway_pid=33 observer_pid=200 observer_external=true workers=294,387
PASS C3.2 charges réelles — stream_epoch_ms=1792850358098.5..1792850388551.3 threshold_ms=2000 files=20000 diff_mib=56 pdf_pages=50 pdf_mib=16.2 pdf_text_kib=171.8 stdout_mib=64 tool_caps=50094/100038/50056 generator_epoch_ms=git:1792850359939..1792850360531,stdout:1792850366148..1792850366198 observed_ms=git(run_command):runs:3/work:2017/overlap:2017.7,pdf(read_file):runs:26/work:2032/overlap:2090.9,stdout(run_command):runs:16/work:2098/overlap:2108.1
PASS C3.3 sondes session — deadlines=641 responses=641 failures=0 missed_deadlines=0 p99_ms=11.2 max_ms=35.9 timeout_ms=500
PASS C3.4 sondes santé — deadlines=641 responses=641 failures=0 missed_deadlines=0 p99_ms=9.4 max_ms=25.3 timeout_ms=500
PASS C3.5 stream témoin — source=external_ws observer_pid=200 start_epoch_ms=1792850358098.5 end_epoch_ms=1792850388551.3 duration_ms=30452.7 chunks_received=1501 chars_received=1501 gap_p99_ms=23.4 gap_max_ms=113.1 final_chars=1501
PASS C3.6 SIGKILL/isolation — signal_epoch_ms=1792850378099.5 signal_t_ms=20001 post_kill_ms=10451.8 gateway_pid=33 witness_pid=294 generation=1 witness_observations=305 witness_first_last_epoch_ms=1792850358101.5..1792850388501.3 witness_pre_post=200/105 witness_failures=0 witness_mismatches=0 perturbator_pid=387 alive=false child_pid=662 child_pgid=662 child_start=linux:58402628 pre_epoch_ms=1792850378099.4 pre_pid_alive=true pre_group_alive=true crash_inventory_epoch_ms=1792850378144 crash_inventory_match=true post_epoch_ms=1792850388611.3 post_pid=absent post_group_alive=false
PASS C3.7 MCP/orphelins — mcp_connected=true mcp_reply=true mcp_pid=178->178 mcp_start=linux:58401630->linux:58401630 mcp_observed_epoch_ms=1792850356440.3..1792850378782.8 stable=true orphan_inventory_epoch_ms=1792850378144 orphan_check_epoch_ms=1792850380144 orphan_delay_ms=2000 orphan_after_signal_ms=2044.5 identities=0 groups=0 reservations=0 errors=0
VERDICT GLOBAL: PASS
npm notice
npm notice New major version of npm available! 11.19.0 -> 12.2.1
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.1
npm notice To update run: npm install -g npm@12.2.1
npm notice
```

Code de sortie : `0`.
