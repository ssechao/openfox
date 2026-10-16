# Session storage maintenance

## Verified benchmark

Measured on 2026-10-16 using a SQLite backup of the production database. Production was not modified.

| Metric                     |                              Before |                                       After |
| -------------------------- | ----------------------------------: | ------------------------------------------: |
| Database file              |                 1,460,146,176 bytes |                         1,012,715,520 bytes |
| Snapshot payloads          |                 1,439,654,221 bytes |                           994,569,353 bytes |
| Archived results compacted |                                   — |                                       3,120 |
| Snapshots rewritten        |                                   — |                                     46 / 90 |
| Integrity check            |                                  ok |                                          ok |
| Global session list        |         11.043 s on the live server | 110 ms, 61 ms, 35 ms on the maintained copy |
| Node RSS after global list | 1,748 MiB on the loaded live server | 1,083 MiB in the isolated copy-server probe |

The file reduction was 447,430,656 bytes (30.6%). Snapshot payloads fell by 445,084,868 bytes (30.9%). The memory figures are directional rather than directly comparable: the live server had active sessions and multiple WebSocket clients, while the copy-server probe was isolated. The latency result satisfies the sub-500 ms target and the route test additionally asserts that neither EventStore snapshot nor prompt extraction methods are called.

## Maintenance procedure

1. Build and validate the target revision.
2. Stop every OpenFox process using the database, including ports 450 and 10550 if they share it.
3. Confirm no process holds the database:
   `lsof -t -- "<database-path>"` must exit 1 with empty stdout and stderr.
4. Run:
   `OPENFOX_DB_PATH="<database-path>" npm run optimize:snapshots -- --yes --server-stopped`
5. The command checks source integrity, creates and verifies a SQLite backup, refreshes recent prompts, removes redundant streams, compacts only large tool results from closed context windows, deletes obsolete snapshots, checkpoints WAL, vacuums, and checks integrity again.
6. Preserve the printed backup path until the deployment has been exercised. The same verified backup is reused by every migration stage; no second full backup is created.
7. Start OpenFox 450, verify health and global-list latency, then start 10550.
8. If integrity, history, or replay is wrong, stop all instances and restore the verified backup before restarting.
9. Once the deployment is accepted, the backup can be deleted explicitly. Any timestamped maintenance backup older than 10 days is automatically pruned by the next maintenance run.

The command refuses to run without both confirmation flags or while `lsof` reports an open database. Probe errors, source corruption, backup failure, or backup corruption abort before snapshot rewriting.

## Related follow-up tasks

These are tracked on the project task board:

- `7e71ef74df91998b`: content-addressed attachment/blob storage.
- `e3fec8ae908f9d53`: lightweight FTS-backed global search.
- `1ed948f63fd57ece`: snapshot cache metrics and memory bounds.
- `206b7b4c79dbfb9d`: shared/multiplexed WebSocket connection across tabs.
- `d0d5e1f76b1975b4`: Responses `previous_response_id` continuity.
