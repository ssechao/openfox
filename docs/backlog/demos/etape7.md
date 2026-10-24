# Étape 7 — Démo C3 chiffrée

## Diagnostic 7d — blocages gateway et orphelin

Profilage sur `.122` du code applicatif `6d5c2b5b` avec `node --cpu-prof` et une sonde de retard de boucle à 20 ms. Les blocages horodatés coïncident avec les charges réelles : jusqu’à 944 ms pendant le diff/stdout, puis 802 ms lors de la récupération après SIGKILL. Sur 39 358 échantillons gateway, les principaux postes non idle sont `express`/`JSON.stringify` (1 695), GC (1 318), décodage des lignes EventStore (`rowToStoredEvent`, 759 sur les entrées sourcemap dupliquées), puis encodage/décodage UTF-8. Git, l’extraction PDF et la capture stdout s’exécutent bien dans le worker; ils ne sont pas dans les piles chaudes gateway.

Cause performance : chaque fragment `tool.output` des 56 Mio de diff et 64 Mio de stdout est persisté, relayé worker → superviseur → gateway, puis diffusé en WS sans budget serveur. Les lectures de session replient ensuite ce journal intégral dans `streamingOutput` et `res.json` le sérialise, bien que le résultat final soit borné à 50 Kio. Le profil montre les deux rafales `rowToStoredEvent`/`stringify`/GC pendant le relais puis lors de la lecture finale de la session perturbatrice. L’écriture SQLite synchrone reste dans le worker et le PDF ne produit pas de gros relais : ce ne sont pas les causes du blocage gateway observé.

Cause orphelin : le nettoyage envoie bien SIGTERM/SIGKILL au groupe enregistré. Une reproduction minimale dans le même conteneur laisse toutefois le descendant tué en état Linux `Z`, `PPID=1`, avec son PGID encore visible; le PID 1 du conteneur ne le réape pas. `readProcessInventory` et `kill(-pgid, 0)` classent ce zombie non exécutable comme vivant, et aucun signal supplémentaire ne peut le faire disparaître. Le nettoyage doit donc garantir le réapage par un ancêtre responsable, pas répéter le kill ni masquer silencieusement l’état.

## Rejeu final

Exécution UTC du `2026-10-24T11:03:32Z` sur `.122`, depuis le checkout copié dans `/tmp/openfox-etape7`.

SHA testé : `7ed7957d900d391629da1684db569d30da2e1ff4`

```bash
docker --context pve8 run --rm --user node -v /tmp/openfox-etape7:/work -w /work node:24-bookworm sh -c 'npx tsx scripts/demo-etape7.ts 2>&1'
```

Sortie complète exacte (stdout + stderr) :

```text
Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.
[2026-10-24T11:03:32.392Z] [ERROR] Session worker died {"sessionId":"a113e55b-6902-44db-913d-05dc7133f773","workerId":"3c153190-b003-4de8-8bbe-6dceec378aca","generation":1,"exitCode":null,"signal":"SIGKILL","stderr":["Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided."]}
RÉSUMÉ CHIFFRÉ — Étape 7 C3
PASS C3.1 isolation/pool — revision=7ed7957d900d391629da1684db569d30da2e1ff4 db_temp=true port=39503 pool=2 gateway_pid=32 observer_pid=200 observer_external=true workers=294,387
PASS C3.2 charges réelles — stream_epoch_ms=1792839792383.5..1792839822745.1 files=20000 diff_mib=56 pdf_pages=50 pdf_mib=16.2 pdf_text_kib=171.8 stdout_mib=64 tool_caps=50094/100038/50056 generator_epoch_ms=git:1792839792859..1792839793461,stdout:1792839793867..1792839793914 observed_ms=git(run_command):675.8/overlap:675.8,pdf(read_file):317.2/overlap:317.2,stdout(run_command):128.4/overlap:128.4
PASS C3.3 sondes session — deadlines=642 responses=642 failures=0 missed_deadlines=0 p99_ms=3.4 max_ms=20.8 timeout_ms=500
PASS C3.4 sondes santé — deadlines=642 responses=642 failures=0 missed_deadlines=0 p99_ms=1.8 max_ms=9.7 timeout_ms=500
PASS C3.5 stream témoin — source=external_ws observer_pid=200 start_epoch_ms=1792839792383.5 end_epoch_ms=1792839822745.1 duration_ms=30361.6 chunks_received=1501 chars_received=1501 gap_p99_ms=22 gap_max_ms=31.3 final_chars=1501
PASS C3.6 SIGKILL/isolation — signal_epoch_ms=1792839812383.9 signal_t_ms=20000.4 post_kill_ms=10361.2 gateway_pid=32 witness_pid=294 generation=1 witness_observations=304 witness_first_last_epoch_ms=1792839792387.2..1792839822686.8 witness_pre_post=200/104 witness_failures=0 witness_mismatches=0 perturbator_pid=387 alive=false child_pid=501 child_pgid=501 child_start=linux:57345394 pre_epoch_ms=1792839812383.7 pre_pid_alive=true pre_group_alive=true crash_inventory_epoch_ms=1792839812392 crash_inventory_match=true post_epoch_ms=1792839822798.3 post_pid=absent post_group_alive=false
PASS C3.7 MCP/orphelins — mcp_connected=true mcp_reply=true mcp_pid=178->178 mcp_start=linux:57345048->linux:57345048 mcp_observed_epoch_ms=1792839790616.9..1792839812940.2 stable=true orphan_inventory_epoch_ms=1792839812392 orphan_check_epoch_ms=1792839814392 orphan_delay_ms=2000 orphan_after_signal_ms=2008.1 identities=0 groups=0 reservations=0 errors=0
VERDICT GLOBAL: PASS
npm notice
npm notice New major version of npm available! 11.19.0 -> 12.2.1
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.1
npm notice To update run: npm install -g npm@12.2.1
npm notice
```

Code de sortie : `0`.
