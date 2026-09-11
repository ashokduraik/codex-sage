# Local MongoDB 8 replica set (macOS / Homebrew)

codex-sage talks to an **external MongoDB 8 replica set**. Multi-document transactions
require a replica set, even for a single node on a laptop.

This is the local development setup. Production provisioning is out of scope (plan
decision D5 / D11). The app connection string is:

```text
mongodb://127.0.0.1:27017/codex_sage?replicaSet=rs0
```

Set that as `MONGODB_URI` in `backend/.env` when Phase 01 wires the config.

Apple Silicon Homebrew paths are `/opt/homebrew/...`. Intel Homebrew uses
`/usr/local/...` instead.

---

## 1. Install

```bash
brew tap mongodb/brew
brew install mongodb-community@8.0 mongosh mongodb-database-tools
```

Confirm:

```bash
mongod --version    # 8.0.x
mongosh --version
```

---

## 2. Enable a dummy replica set

Edit the Homebrew config (`/opt/homebrew/etc/mongod.conf` or
`/usr/local/etc/mongod.conf`) and add a `replication` block. Leave the rest of the
file as Homebrew shipped it.

```yaml
systemLog:
  destination: file
  path: /opt/homebrew/var/log/mongodb/mongo.log
  logAppend: true
storage:
  dbPath: /opt/homebrew/var/mongodb
net:
  bindIp: 127.0.0.1, ::1
  ipv6: true
replication:
  replSetName: rs0
```

`rs0` must match `replicaSet=rs0` in `MONGODB_URI`. Bind to localhost only.

---

## 3. Start, stop, restart

| Action | Command |
| --- | --- |
| Start (and keep running after logout) | `brew services start mongodb-community@8.0` |
| Stop | `brew services stop mongodb-community@8.0` |
| Restart (after config edits) | `brew services restart mongodb-community@8.0` |
| Status | `brew services list \| grep mongodb` |

A successful start looks like:

```text
mongodb-community@8.0 started  <you>  ~/Library/LaunchAgents/sh.brew.mongodb-community@8.0.plist
```

`started` in that list is not enough by itself. Confirm the process is actually
listening:

```bash
mongosh --quiet --eval 'db.adminCommand({ ping: 1 })'
lsof -nP -iTCP:27017 | head
```

### One-shot (foreground, no launchd)

Useful when debugging a failed start. Stop the brew service first so the port is
free.

```bash
brew services stop mongodb-community@8.0
mongod --config /opt/homebrew/etc/mongod.conf
```

Ctrl-C stops it. To daemonize without brew:

```bash
mongod --config /opt/homebrew/etc/mongod.conf --fork
mongosh --quiet admin --eval 'db.shutdownServer()'
```

---

## 4. Initialize the replica set (once)

After mongod is listening with `replSetName: rs0`, initialize the single-node set.
Skip this if `rs.status()` already returns set `rs0`.

```bash
mongosh --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] })'
```

Wait until the member is PRIMARY:

```bash
mongosh --quiet --eval 'db.hello().isWritablePrimary'
# true
```

If you already ran `rs.initiate` and see `already initialized`, that is fine — do
not run it again.

---

## 5. Verify

```bash
mongosh --quiet "mongodb://127.0.0.1:27017/codex_sage?replicaSet=rs0" --eval '
const s = rs.status();
print("set: " + s.set);
s.members.forEach(m => print(m.name + "  " + m.stateStr + "  health=" + m.health));
print("writablePrimary: " + db.hello().isWritablePrimary);
'
```

Expected: set `rs0`, one member `PRIMARY`, `health=1`, `writablePrimary: true`.

Transactions only work on a replica set. This smoke test should commit:

```bash
mongosh --quiet "mongodb://127.0.0.1:27017/codex_sage?replicaSet=rs0" --eval '
const session = db.getMongo().startSession();
session.startTransaction();
session.getDatabase("codex_sage").replica_set_smoke_test.insertOne({ ok: true });
session.commitTransaction();
session.endSession();
db.replica_set_smoke_test.drop();
print("ok");
'
```

---

## 6. Paths

| What | Apple Silicon Homebrew |
| --- | --- |
| Config | `/opt/homebrew/etc/mongod.conf` |
| Data | `/opt/homebrew/var/mongodb` |
| Server log | `/opt/homebrew/var/log/mongodb/mongo.log` |
| launchd stdout/stderr | `/opt/homebrew/var/log/mongodb/output.log` |
| LaunchAgent | `~/Library/LaunchAgents/sh.brew.mongodb-community@8.0.plist` |
| Binary | `/opt/homebrew/opt/mongodb-community@8.0/bin/mongod` |

---

## 7. Troubleshooting

**`brew services` says started, but port 27017 is closed.** launchd sometimes
records the job as loaded with `runs = 0` and never spawns mongod (common when
the service is started from a non-GUI shell). Force a spawn:

```bash
launchctl kickstart -p gui/$(id -u)/sh.brew.mongodb-community@8.0
```

Then ping again. If it still fails:

```bash
launchctl print gui/$(id -u)/sh.brew.mongodb-community@8.0 | head -40
tail -50 /opt/homebrew/var/log/mongodb/output.log
tail -50 /opt/homebrew/var/log/mongodb/mongo.log
```

**`Bootstrap failed: 5: Input/output error`.** The LaunchAgent is in a bad
state. Unload and start cleanly:

```bash
brew services stop mongodb-community@8.0
launchctl bootout gui/$(id -u)/sh.brew.mongodb-community@8.0
brew services start mongodb-community@8.0
```

**`ECONNREFUSED 127.0.0.1:27017`.** mongod is not running. Start it, then check
the logs. A missing log file usually means launchd never executed the binary.

**`NotYetInitialized: Replication has not yet been configured`.** Config has
`replSetName` but `rs.initiate` has not been run. Go back to section 4.

**Drivers hang or fail with replica-set errors.** The URI must include
`replicaSet=rs0`, and `rs.status()` must show a PRIMARY. A standalone mongod
(no `replication` block) will not accept transaction sessions.

**Port already in use.** Another mongod is running. Stop the brew service, then
`lsof -nP -iTCP:27017` and stop any leftover `--fork` process.
