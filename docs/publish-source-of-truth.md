# npm publish source of truth

`packages/proxy` in this repo (`turleydesigns/relayplane-workflows`) is the single confirmed sync source for both `github.com/RelayPlane/proxy` and the `@relayplane/proxy` npm package. No other clone or copy of the proxy source feeds either destination.

`.github/workflows/release-proxy.yml` triggers on push to `main` for changes under `packages/proxy/**` (and `packages/core/**`), builds, versions, and publishes to npm, then syncs the built package to the public `RelayPlane/proxy` repo.

Confirmed by reading the workflow trigger directly (`branches: [main]`, `paths: packages/proxy/**`), not inferred. This means edits to `packages/proxy/README.md` in this repo are the ones that ship to both npm and the public GitHub mirror on the next merge to `main` and publish run, with no intermediate manual copy step.
