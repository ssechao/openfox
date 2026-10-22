# Lot 4a-2 — Critères (GC, backup, rollback)

Planner : session Grok, titre Aether « Planner 4a-2 GC/backup/rollback ». Révision : 2026-10-22 (Astra / pilote, 3 précisions). Aucun code écrit.

Périmètre 4a-2 : ce qui rend 4a-1 déployable. (a) ramasse-miettes des blobs orphelins, sans jamais supprimer un blob référencé, même pendant une écriture concurrente ; (b) sauvegarde/export cohérente base + blobs, et import/restauration ; (c) retour arrière de la migration 4a-1 : réinliner les blobs dans les snapshots, reprenable et sous verrou, pour revenir à la version d’avant 4a-1.

Hors périmètre : FTS5 (4b), cache snapshots (4c), prod. 4a-1 reste hors prod tant que 4a-2 n’est pas livré. Jamais la base live.

Référence plan : `docs/backlog/plan-multithread.md` § Étape 4 / 4a-2. Base acceptée : `origin/mt/etape4a1-blobs` (`150b0c8f`). Crash = processus enfant + `SIGKILL`, même harnais que 4a-1 (`parkAtBlobBarrier` / `killAtBarrier`).

---

## 3 critères (une commande chacun)

### C1 — GC des orphelins, aucune ref vivante cassée

Commande :

```bash
npx vitest run src/server/events/blob-gc.test.ts
```

- **Orphelin** : plus aucun `BlobRef` (`{hash,mime,size}` validé par `isBlobRef`) dans `events.payload`. Sources : `deleteSession`, `cleanupOldEvents`, `optimizeStorage`, crash 4a-1 après écriture durable du blob et avant commit de la référence. Le GC supprime le fichier, le `.mime` et les `.tmp-*` restants.
- **Ref vivante conservée** : une ou plusieurs sessions (dédup SHA-256). Un payload tombstoné encore en table compte comme une référence : le blob n’est pas orphelin tant que la ligne existe.
- **Écriture concurrente** : un enfant **vivant** parké à `after-blob-write` (même `FileBlobStore`) : le GC ne supprime pas ce blob. Après `append`, la ref résout octet à octet.
- **Crash GC** : `SIGKILL` pendant le GC. Aucune ref vivante ne devient illisible. Reprise idempotente (second passage = no-op sur les blobs encore référencés).
- **Scan** : uniquement via `isBlobRef`. Un 64-hex brut dans le texte n’est pas une référence. Rater un `BlobRef` est fatal ; garder un fichier en trop est acceptable.
- **Dossier de blobs ↔ base (choix : un dossier par base).** Racine dérivée du chemin de la base : `<dbPath>.blobs` (plus le `dirname(db)/blobs` de 4a-1, qui collisionne dès que deux bases partagent un parent). Fichier marqueur (ex. `.openfox-db`) portant l’identité de la base (`realpath`). Le GC **refuse** (aucune suppression) si le marqueur est absent ou ne correspond pas.
- **Test dossier partagé** : deux bases rattachées au **même** dossier de blobs, chacune y a écrit un blob distinct. Le GC lancé sur l’une **ne supprime jamais** le blob référencé par l’autre (refus pour marqueur, ou conservation après scan — les deux passent ; détruire le blob de l’autre échoue).
- **CLI** : `scripts/gc-blobs.ts --yes --db <path>` sous verrou d’instance (refuse si verrouillé, même motif que `migrate-blobs.ts`). Jamais lancé au démarrage. Pas de `setImmediate`.
- Bases temporaires seulement. `lsof` : 0 fichier sous `~/Library/Application Support/openfox`.

### C2 — Sauvegarde/export cohérente base + blobs, import/restauration

Commande :

```bash
npx vitest run src/server/events/blob-backup.test.ts
```

- **Backup en ligne** : autorisé pendant que l’instance tourne, **sans** verrou d’instance. Test obligatoire : sauvegarde **pendant des écritures concurrentes** (append d’events + `put` de blobs). Le snapshot sqlite (API `backup`, WAL inclus) et les blobs de **ce** snapshot restent cohérents.
- **Publication atomique** : écriture dans un répertoire temporaire. La sauvegarde n’est **publiée** (rename atomique du répertoire + manifeste final) que si la base **et** tous les blobs référencés par ce snapshot (body + `.mime`) sont copiés. Copier `sessions.db` à la main sans l’API `backup` est hors contrat.
- **Échec explicite, rien de publié** : si un blob manque (GC concurrent, disque, hash du snapshot absent), le backup échoue et le répertoire temporaire est abandonné. Aucun manifeste final, aucun rename vers l’emplacement publié.
- **Crash backup** : `SIGKILL` en cours de backup. Rien n’est publié. Restore refuse (manifeste incomplet ou blob manquant). Jamais un succès à refs pendantes.
- **Restore** : dans un répertoire isolé, **sous verrou d’instance** (refuse si la cible est ouverte). Chaque `BlobRef` résout, octets et MIME identiques, `EventStore` hydrate.
- **Export de session** : le document embarque les octets des refs (plus seulement `{hash,mime,size}`). Import dans un autre projet restaure les fichiers et hydrate. Un export v1 inline (avant 4a-1) reste importable.
- **CLI** : backup sans verrou ; restore `--yes --db <path>` sous verrou. Bases temporaires seulement.
- `lsof` : 0 fichier sous `~/Library/Application Support/openfox`.

### C3 — Retour arrière de la migration 4a-1

Commande :

```bash
npx vitest run src/server/events/blob-rollback.test.ts
```

- **Réinline** tous les `BlobRef` au format lu par le code d’**avant 4a-1** (`origin/mt/etape3-async`) : `attachments.data` en data-URL ; `toolCalls[].result.metadata.base64Data` **et** `metadata.dataUrl` (exigé par `fold-messages.handleToolResult` et `image-processor.hasImageMetadata`) ; tout autre champ binaire que cet ancien parseur lit (`url` data-URL si 4a-1 l’avait extrait). Plus de `{hash,mime,size}` dans les payloads. Octets identiques à l’original.
- **Test parseur d’avant 4a-1** : un fixture (payloads après rollback) est relu par le code d’`origin/mt/etape3-async` (copie figée sous `src/server/events/fixtures/pre-4a1/` ou import du commit `etape3-async`). `hasImageMetadata` / `handleToolResult` voient `dataUrl` ; les attachments ont `data`. Échec si l’ancien code ignore l’image.
- **Bascule par session**, une transaction (hydrate puis switch, miroir de 4a-1 copie-puis-bascule).
- **Crash** : `SIGKILL` aux barrières `after-hydrate` / `before-switch` / `after-switch`. Reprise sans session à moitié inline, sans perte, sans doublon. Interruption avant bascule : snapshots inchangés (encore en refs).
- **Aucun blob n’est supprimé par le rollback.** Ni avant ni après la bascule. Le GC (C1) s’en charge ensuite, une fois les payloads réinlinés et plus aucune ref.
- **CLI** : `scripts/rollback-blobs.ts --yes --db <path>` sous verrou d’instance, refuse si verrouillé, jamais au démarrage.
- Couvre les sessions migrées **et** les écritures natives 4a-1 (pas seulement `blob_migration=switched`).
- Après rollback, un lecteur sans blob-store parse les events en inline.
- Bases temporaires seulement.

---

## Contraintes communes

- Jamais la base live (`~/Library/Application Support/openfox/sessions.db`). Corpus et tests en tmp, comme 4a-1.
- Crash = enfant `fork` + `SIGKILL`, harnais 4a-1 (`blob-crash-harness.ts` étendu aux modes `gc` / `backup` / `rollback`).
- Commandes CLI explicites, `--yes` obligatoire, désactivées par défaut. Aucun lancement au boot (`initEventStore` / `setImmediate`).
- Verrou d’instance : GC, rollback et **restore** refusent si la base est ouverte (même contrat que `scripts/migrate-blobs.ts`). **Le backup C2 est l’exception** : en ligne, sans verrou.
- `docs/backlog/` est dans `.git/info/exclude` : forcer le fichier (`git add -f`) comme `etape4a1-criteres.md`.

Worktree de build (pas encore créé) :

```bash
git worktree add ~/Source/github.com/OpenFoxFork-mt-etape4a2 -b mt/etape4a2-gc origin/mt/etape4a1-blobs
npx husky
git config openfox.testRemote ssechao@192.168.71.122
```

---

## Risques

1. **Race GC vs `put`.** 4a-1 écrit le blob avant la ref. Un GC qui ne lit que `events` prend l’in-flight pour un orphelin. Le test enfant vivant à `after-blob-write` est obligatoire. Piste : génération / grace / fichier `.tmp` encore présent = non orphelin.
2. **Dédup.** Supprimer une session ne doit pas GC un blob encore cité ailleurs. Compter les refs, pas les sessions.
3. **Tombstones.** `tombstoneEvents` laisse le payload en table. Orphelins réels : `deleteSession` / `cleanupOldEvents` / `optimizeStorage` / crash avant commit.
4. **Scan 64-hex brut.** Un hash dans le texte d’un message n’est pas une ref. Rater un `BlobRef` supprime un binaire vivant. Un faux positif (fichier conservé) est acceptable.
5. **Dossier partagé.** 4a-1 pose `dirname(db)/blobs` : deux bases dans le même parent partagent le dossier. C1 impose `<dbPath>.blobs` + marqueur. Le test à deux bases sur un même dossier de blobs est obligatoire.
6. **WAL.** Copier `sessions.db` sans l’API `backup` oublie le WAL → restore incohérente. C2 exige `Database.backup()`.
7. **Backup en ligne vs GC.** Un blob référencé par le snapshot sqlite peut disparaître pendant la copie. C2 échoue alors et **ne publie rien**. Ne pas « réparer » en omettant le blob.
8. **Publication partielle.** Un rename du sqlite avant la fin des blobs, ou un manifeste écrit trop tôt, rend un crash restaurable à refs pendantes. Manifeste final **après** copie complète, puis rename atomique du répertoire.
9. **Export v1.** `importEvents` aujourd’hui réécrit le payload tel quel, sans poser les blobs. Sans C2, un export 4a-1 importe des refs pendantes. L’export v1 inline doit rester importable.
10. **Rollback sans unlink.** C3 ne touche pas aux fichiers blobs. Un `unlink` avant/pendant la bascule + `SIGKILL` = perte. Le disque ne redescend qu’après C1.
11. **`dataUrl` vs `base64Data`.** L’ancien `fold-messages` et `image-processor` exigent `metadata.dataUrl`. Réinliner seulement `base64Data` laisse l’image invisible à l’ancien code. Le fixture parseur d’avant 4a-1 est le filet.
12. **Pas d’auto au boot.** Ne pas copier `migrateSnapshotStreams` en `setImmediate`. GC, backup, restore et rollback restent des commandes explicites.
13. **Base live / VACUUM.** Interdit. Une copie de prod 1,34 Gio avec `freelist_count` élevé hangue. Tests en tmp, comme 4a-1.
14. **`.tmp-*`.** Un crash 4a-1 peut laisser un temporaire. C1 le nettoie s’il n’est pas une écriture en cours (enfant vivant / rename non fait).
15. **Verrou.** GC, rollback, restore refusent une base déjà ouverte. Backup C2 non. Un test lock par CLI concerné (fork `instance-lock.test-child.ts`).
