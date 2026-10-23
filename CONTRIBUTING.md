# Contributing to Cablegram Community Server

Thanks for helping. Pull requests are welcome: bug fixes, tests, documentation and self-hosting improvements.

## Before you open a pull request

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- Issues labelled [`good first issue`](https://github.com/seep-labs/cablegram-server/labels/good%20first%20issue)
  are a good place to start. Comment on one to claim it.
- Run the checks CI runs, with Node.js 22:

  ```bash
  npm ci
  npm run typecheck
  npm run build
  npm test
  ```

- A change to an HTTP route or a response the apps rely on must keep working with the released phone and TV apps.
  Describe the compatibility impact in the pull request.
- Never commit secrets, tokens or pairing codes, including in tests and logs.

## Sign-off

Sign off every commit with the [Developer Certificate of Origin](https://developercertificate.org/):
`git commit -s`. A CI check verifies it. Your contribution is licensed under GPL-3.0-only, like the rest of the
repository.

## How changes are merged

The same core code also runs the hosted Cablegram service, maintained in a private repository. After a pull request
is merged here, a maintainer imports it there with your authorship kept, and later releases include it. Keeping a
pull request small and focused makes that step quick.

Maintainers merge with squash, so your pull request becomes one commit under your name.

## Security issues

Do not report security issues in public issues or pull requests. Follow [`SECURITY.md`](SECURITY.md).
