# 9router-development

My development clone of [9router](https://github.com/decolua/9router) — for building
features for my own use **and** contributing them back upstream to `decolua/9router`.

The deployed instance lives in `../9router-source` (do not develop there).

## Remotes

| Remote | Points to | Purpose |
|---|---|---|
| `origin` | `git@github.com:bavuongco10/9router.git` (my fork) | push branches, open PRs |
| `upstream` | `https://github.com/decolua/9router.git` | sync `master`, target upstream PRs |

## Branch model

| Branch | Tracks | Package manager | Role |
|---|---|---|---|
| `master` | mirrors `upstream/master` | npm (upstream default) | clean base — kept identical to decolua so upstream PRs stay noise-free |
| `main` | my fork | **pnpm** | my diverged code; what the local Docker build uses; carries the pnpm switch |

`master` stays pristine. All my divergence (pnpm, local tweaks) lives on `main`.

## Keep master in sync with upstream

```sh
git fetch upstream
git checkout master
git merge --ff-only upstream/master   # fast-forward only; master should never have own commits
git push origin master
```

Then bring `main` up to date with the new upstream code:

```sh
git checkout main
git merge master          # or: git rebase master
git push origin main
```

## Develop a feature (PR to BOTH master and main)

Branch off **clean `master`** so the upstream PR carries only the feature
(no pnpm/local noise):

```sh
git checkout master
git checkout -b feat/my-feature
# ...code...
git commit -am "feat: ..."
git push -u origin feat/my-feature
```

**PR #1 → upstream master** (contribution to decolua):
`https://github.com/decolua/9router/compare/master...bavuongco10:9router:feat/my-feature`

Then port the same commit onto `main` (which has pnpm) for my own instance:

```sh
git checkout main
git checkout -b feat/my-feature-main
git cherry-pick <feature-sha>
git push -u origin feat/my-feature-main
```

**PR #2 → my main**:
`https://github.com/bavuongco10/9router/compare/main...feat/my-feature-main`

## Local development

Requires Node 22 (matches `node:22-alpine` in the Dockerfile) and pnpm via corepack:

```sh
nvm use 22
corepack enable
pnpm install            # builds better-sqlite3/sharp/unrs-resolver (allowlisted in pnpm-workspace.yaml)
pnpm dev                # Next.js dev server on http://localhost:3000
```

Port **3000** is reserved for development (the homepage container only exposes 3000
internally, so there's no host conflict).

### Dev database

Use a **clone** of the expose DB, never the live one. A read-only snapshot is at
`../data-development/db/data.sqlite` (created via `sqlite3 .backup`). Point the dev
server's `DATA_DIR` at a dev-only data dir — do not mount `../data-expose`.

To refresh the snapshot from current live data:

```sh
sqlite3 ../data-expose/db/data.sqlite ".backup '../data-development/db/data.sqlite'"
```

## Local Docker build

The Docker build (on `main`) uses pnpm: `corepack enable` → `pnpm install --frozen-lockfile`
→ `pnpm run build`. `better-sqlite3` compiles in-image (alpine has python3/make/g++);
locally it falls back to `sql.js` if not built, since it's an optional dependency.

## Notes

- `package-lock.json` is gitignored upstream, so `master` has no npm lockfile to manage.
- `pnpm-lock.yaml` + `pnpm-workspace.yaml` are committed on `main` only.
- `master` must never carry its own commits — if it does, `--ff-only` sync will fail (by design).
