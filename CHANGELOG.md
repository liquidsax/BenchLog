# Changelog

## [Unreleased]

### Added

- Install BenchLog with `bun install` in this repo, or `bun`/`npm install` of the `benchlog` package, and start it with the `benchlog` command. The CLI runs the published oh-my-pi harness with the serial tools and does not ask for a separate global `omp` install.

### Changed

- The repository front is BenchLog. The README opens with a BenchLog banner and the `benchlog` install; upstream product hero, demo gallery, and marketing screenshots are gone.
- A default install no longer installs the mirrored oh-my-pi workspace or the Hugging Face, sherpa, ONNX, or omp-stats React icon stacks. The linux x64 `node_modules` budget is 500 MiB; `bun scripts/check-install-size.ts` checks a clean install.
