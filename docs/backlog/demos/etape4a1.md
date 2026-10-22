# Démo — Lot 4a-1 : blobs hors des instantanés

Branche `mt/etape4a1-blobs`. Mesures du 2026-10-22.

HOME, config et `OPENFOX_DB_PATH` temporaires, ports ≥ 10720. Corpus synthétique
(`docs/backlog/corpus/`, graine 41) généré en tmp : 7 651 messages, instantané
106 931 650 octets, `display.maxVisibleItems=50`. Aucune base de production
ouverte (`lsof`).

## Commandes

```bash
npx vitest run src/server/events/blob-store.test.ts
npx vitest run src/server/events/blob-migrate.test.ts
npx vitest run src/server/plugins/asset-auth.test.ts
npx vitest run --config e2e/vitest.config.ts e2e/blob-open.demo.test.ts
```

Migration réelle : `npx tsx scripts/migrate-blobs.ts --yes --db <path>` (désactivée
au démarrage ; WAL checkpointée après la bascule).

Les `<img>` chargent `/api/blobs/<hash>?token=` via `pluginAssetToken` (même jeton
que les assets de plugins). Pas de route publique. Un `token` en query sur
`/api/sessions/:id` reste 401.

## Résultats

| Critère                                           | Commande                 | Résultat |
| ------------------------------------------------- | ------------------------ | -------- |
| C1 stockage, réhydratation, durabilité, intégrité | `blob-store.test.ts`     | 9/9      |
| C2 migration atomique, reprenable, pas auto       | `blob-migrate.test.ts`   | 6/6      |
| C3 démo corpus, route, droits, rendu              | `blob-open.demo.test.ts` | 1/1      |

## Chiffres C3 (corpus à volumétrie réelle, même recette avant/après)

`GET /api/sessions/:id` à froid, cache vide, médiane de 3, Mac mini chargé.

|                               | Médiane  | Ratio |
| ----------------------------- | -------- | ----- |
| Avant (inline)                | 962,4 ms | —     |
| Après (refs + checkpoint WAL) | 518,4 ms | 0,54  |

Objectif −50 % non atteint sur ce run (non bloquant). Aller-retour PNG par
`GET /api/blobs/<hash>?token=` sans en-tête : 200, octets et MIME identiques.
Sans jeton : 401. Hash inconnu : 404. Hash invalide : 400. UI :
`attachmentDisplaySrc` pose `?token=` (test web MessageAttachments +
AttachmentPreview).

Rapport JSON : `ETAPE4A1_DEMO_REPORT=<fichier>`.
