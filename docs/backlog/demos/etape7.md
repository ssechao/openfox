# Étape 7 — Démo C3 chiffrée

Exécution UTC du `2026-10-24T10:18:37Z` sur `.122`, depuis le checkout copié dans `/tmp/openfox-etape7`.

SHA testé : `6d5c2b5b6642dbc42e5890ddca32bdea564e7849`

```bash
docker --context pve8 run --rm --user node -v /tmp/openfox-etape7:/work -w /work node:24-bookworm npx tsx scripts/demo-etape7.ts
```

Sortie complète exacte (stdout + stderr) :

```text
Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided.
[2026-10-24T10:18:12.752Z] [ERROR] Session worker died {"sessionId":"8b6389be-e657-44ae-b4f7-e990941fe08d","workerId":"2175eeac-0f5f-40ca-b2ac-efb4e6c2c9b4","generation":1,"exitCode":null,"signal":"SIGKILL","stderr":["Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API parameter is provided."]}
[2026-10-24T10:18:14.764Z] [ERROR] Worker zero-orphan proof failed {"sessionId":"8b6389be-e657-44ae-b4f7-e990941fe08d","workerId":"2175eeac-0f5f-40ca-b2ac-efb4e6c2c9b4","orphanCheck":{"checkedAt":1792837094752,"clean":false,"survivingIdentities":[{"pid":456,"startedAt":"linux:57073629","pgid":456,"command":"echo $$ > hold.pid; exec sleep 120"}],"survivingGroups":[456],"liveReservations":[],"errors":[]}}
RÉSUMÉ CHIFFRÉ — Étape 7 C3
PASS C3.1 isolation/pool — revision=6d5c2b5b6642dbc42e5890ddca32bdea564e7849 db_temp=true port=43287 pool=2 gateway_pid=31 observer_pid=197 observer_external=true workers=248,342
FAIL C3.2 charges réelles — stream_epoch_ms=1792837071916.1..1792837109603.4 files=20000 diff_mib=56 pdf_pages=50 pdf_mib=16.2 pdf_text_kib=171.8 stdout_mib=64 tool_caps=50094/100038/50056 generator_epoch_ms=git:1792837072406..1792837073224,stdout:1792837074480..1792837075014 observed_ms=
FAIL C3.3 sondes session — deadlines=785 responses=668 failures=6 missed_deadlines=111 p99_ms=331 max_ms=428.4 timeout_ms=500
FAIL C3.4 sondes santé — deadlines=785 responses=669 failures=6 missed_deadlines=110 p99_ms=326.8 max_ms=421.6 timeout_ms=500
FAIL C3.5 stream témoin — source=external_ws observer_pid=197 start_epoch_ms=1792837071916.1 end_epoch_ms=1792837109603.4 duration_ms=37687.3 chunks_received=1501 chars_received=1501 gap_p99_ms=80.7 gap_max_ms=1570.2 final_chars=1501
FAIL C3.6 SIGKILL/isolation — signal_epoch_ms=1792837091918.9 signal_t_ms=20002.8 post_kill_ms=17684.5 gateway_pid=31 witness_pid=248 generation=1 witness_observations=377 witness_first_last_epoch_ms=1792837071926.7..1792837109526.3 witness_pre_post=200/177 witness_failures=6 witness_mismatches=0 perturbator_pid=342 alive=false child_pid=456 child_pgid=456 child_start=linux:57073629 pre_epoch_ms=1792837091918.9 pre_pid_alive=true pre_group_alive=true crash_inventory_epoch_ms=1792837092752 crash_inventory_match=true post_epoch_ms=1792837109636 post_pid=found post_group_alive=true
FAIL C3.7 MCP/orphelins — mcp_connected=true mcp_reply=true mcp_pid=175->175 mcp_start=linux:57073016->linux:57073016 mcp_observed_epoch_ms=1792837070305.8..1792837096301.1 stable=true orphan_inventory_epoch_ms=1792837092752 orphan_check_epoch_ms=1792837094752 orphan_delay_ms=2000 orphan_after_signal_ms=2833.1 identities=1 groups=1 reservations=0 errors=0
VERDICT GLOBAL: FAIL
npm notice
npm notice New major version of npm available! 11.19.0 -> 12.2.1
npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.1
npm notice To update run: npm install -g npm@12.2.1
npm notice
```

Code de sortie : `1`.
