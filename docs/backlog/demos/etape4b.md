# Démo — Lot 4b : recherche FTS5

Branche `mt/etape4b-fts`. Mesures du 2026-10-22. Référence AVANT : liste complète (`GET /api/sessions`), code courant (pas un checkout `ff2b1018`).

HOME, config et `OPENFOX_DB_PATH` temporaires. Aucune base de production
ouverte (`lsof`). Reconstruction de l’index : commande explicite, jamais au
démarrage.

## Commandes

```bash
npx vitest run src/server/search/fts-index.test.ts
npx vitest run src/server/search/fts-rebuild.test.ts
npx vitest run --config e2e/vitest.config.ts e2e/search.demo.test.ts
```

Rebuild : `npx tsx scripts/rebuild-search-index.ts --yes --db <path>` (verrou d’instance).

## Corpus

Générateur `docs/backlog/corpus/generate.mjs` (mode `search`) : 100 sessions, 12 000 events, graine du manifeste 4a-1. Données en tmp.

## Mesure HTTP bout-en-bout (N = 100)

| Chemin                                                   | p50    | p99     | froid   |
| -------------------------------------------------------- | ------ | ------- | ------- |
| AVANT `GET /api/sessions` (liste complète, code courant) | 9.1 ms | 20.1 ms | 33.2 ms |
| APRÈS `GET /api/sessions?q=xylophone-alpha` (FTS5)       | 3.3 ms | 13.0 ms | 9.4 ms  |

Seuil : p99 APRÈS ≤ 100 ms. Ratio p99 après/avant ≈ 0.65.

## Résultats

| Critère                                                                | Commande                  | Résultat |
| ---------------------------------------------------------------------- | ------------------------- | -------- |
| C1 index FTS5 à l’écriture, même transaction, pas de snapshot en ligne | `fts-index.test.ts`       | vert     |
| C2 route paginée, fixtures, indexReady, p99 ≤ 100 ms                   | `e2e/search.demo.test.ts` | vert     |
| C3 rebuild atomique sous verrou, SIGKILL, jamais au boot               | `fts-rebuild.test.ts`     | vert     |

## MEP (sous contrôle de Souchiam)

1. Arrêter l’instance (450 ou 550).
2. Sauvegarder `sessions.db` + `sessions.db.blobs`.
3. `npx tsx scripts/rebuild-search-index.ts --yes --db <chemin>`.
4. Vérifier `search.indexReady` prêt.
5. Redémarrer.
6. Smoke : recherche d’un terme connu.
