# Contributing

Issues and pull requests are welcome. For a larger change, open an issue first so we can agree on the approach.

## Setup

See [Install in the README](README.md). Splicewright depends on [Remotion](https://remotion.dev/license),
which has its own license; check that you are eligible before you use it.

## Before you open a pull request

```sh
npm test
npm run typecheck
```

- Keep one change per pull request, and say in the description how you checked it.
- Video and audio features have two export routes (layered and Remotion). Read "Two export routes" in
  [CLAUDE.md](CLAUDE.md) before you add one.
- Contributions are released under the [MIT License](LICENSE), the same as the rest of the code.
