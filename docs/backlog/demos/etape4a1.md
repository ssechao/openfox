# Démo — Lot 4a-1 : blobs hors des instantanés

Branche `mt/etape4a1-blobs` (depuis `origin/mt/etape3-async` 16da117c). Mesures du 2026-10-22.

HOME, config et `OPENFOX_DB_PATH` temporaires, ports ≥ 10720. Corpus synthétique (`docs/backlog/corpus/`, graine 41), généré en tmp. Aucune base de production ouverte (`lsof`).

## Commandes

```bash
npx vitest run src/server/events/blob-store.test.ts
npx vitest run src/server/events/blob-migrate.test.ts
npx vitest run --config e2e/vitest.config.ts e2e/blob-open.demo.test.ts
```

Migration réelle : `npx tsx scripts/migrate-blobs.ts --yes --db <path>` (désactivée au démarrage).

## Résultats

| Critère                                           | Commande                 | Résultat |
| ------------------------------------------------- | ------------------------ | -------- |
| C1 stockage, réhydratation, durabilité, intégrité | `blob-store.test.ts`     | 9/9      |
| C2 migration atomique, reprenable, pas auto       | `blob-migrate.test.ts`   | 6/6      |
| C3 démo corpus, route, droits, rendu              | `blob-open.demo.test.ts` | 1/1      |

## Chiffres C3 (corpus synthétique, même recette avant/après)

`GET /api/sessions/:id` à froid, cache vide, médiane de 3, `display.maxVisibleItems=50`.

|                | Médiane  | Échantillons     |
| -------------- | -------- | ---------------- |
| Avant (inline) | 117,8 ms | 3 essais à froid |
| Après (refs)   | 51,3 ms  | 3 essais à froid |
| Ratio          | 0,435    | −56 %            |

Objectif −50 % atteint sur ce corpus (non bloquant s'il avait manqué). Aller-retour PNG : octets et MIME identiques. Route : 401 sans jeton, 404 hash inconnu, 400 hash invalide. UI : `attachmentDisplaySrc` → `/api/blobs/<hash>`.

Rapport JSON : `ETAPE4A1_DEMO_REPORT=<fichier>`.
