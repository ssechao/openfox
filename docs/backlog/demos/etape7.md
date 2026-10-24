# Étape 7 — Démo C3 chiffrée

Exécution du 2026-10-24 sur `.122`, depuis le checkout copié dans `/tmp/openfox-etape7` :

```bash
docker --context pve8 run --rm --user node -v /tmp/openfox-etape7:/work -w /work node:24-bookworm npx tsx scripts/demo-etape7.ts
```

Sortie standard exacte :

```text
RÉSUMÉ CHIFFRÉ — Étape 7 C3
PASS C3.1 isolation/pool — db_temp=true port=43301 pool=2 gateway_pid=31 workers=205,256
PASS C3.2 charges réelles — files=20000 diff_mib=56 pdf_pages=50 pdf_mib=16.2 pdf_text_kib=171.8 stdout_mib=64 tool_caps=50093/50055 intervals_ms=git:3413.2/overlap:3413.2,pdf:3182.9/overlap:3182.9,stdout:2699.8/overlap:2699.8
PASS C3.3 sondes session — responses=620 failures=0 p99_ms=3.2 max_ms=25.1 timeout_ms=500
PASS C3.4 sondes santé — responses=620 failures=0 p99_ms=2.9 max_ms=7.1 timeout_ms=500
PASS C3.5 stream témoin — duration_ms=30388.3 chunks=1501 gap_p99_ms=21.5 gap_max_ms=31.6 final_chars=1501
PASS C3.6 SIGKILL/isolation — kill_t_ms=19999.6 post_kill_ms=10388.7 gateway_pid=31 witness_pid=205->205 generation=1->1 stable=true perturbator_pid=256 alive=false
PASS C3.7 MCP/orphelins — mcp_connected=true mcp_reply=true orphan_delay_ms=2001 identities=0 groups=0 reservations=0 errors=0
VERDICT GLOBAL: PASS
```
