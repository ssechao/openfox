# Démo — Lot 4a-2 : GC, backup, rollback

Branche `mt/etape4a2-gc`. Mesures du 2026-10-22.

HOME, config et `OPENFOX_DB_PATH` temporaires. Aucune base de production
ouverte (`lsof`). 4a-1 reste hors prod : ce lot le rend déployable.

## Commandes

```bash
npx vitest run src/server/events/blob-gc.test.ts
npx vitest run src/server/events/blob-backup.test.ts
npx vitest run src/server/events/blob-rollback.test.ts
```

GC : `npx tsx scripts/gc-blobs.ts --yes --db <path>` (verrou d’instance).
Backup en ligne : `npx tsx scripts/backup-blobs.ts --yes --db <path> --out <dir>`.
Restore : `npx tsx scripts/restore-blobs.ts --yes --from <dir> --db <path>` (verrou).
Rollback : `npx tsx scripts/rollback-blobs.ts --yes --db <path>` (verrou).
Aucune de ces commandes n’est lancée au démarrage.

Le dossier de blobs est `<dbPath>.blobs` avec marqueur `.openfox-db`.

## Résultats

| Critère                                                 | Commande                | Résultat |
| ------------------------------------------------------- | ----------------------- | -------- |
| C1 GC orphelins, dossier par base, enfant vivant        | `blob-gc.test.ts`       | vert     |
| C2 backup en ligne, publication atomique, export/import | `blob-backup.test.ts`   | vert     |
| C3 rollback dataUrl + parseur d’avant 4a-1, sans unlink | `blob-rollback.test.ts` | vert     |

Les tests 4a-1 (`blob-store.test.ts`, `blob-migrate.test.ts`) restent verts
avec le nouveau chemin `<dbPath>.blobs`.
