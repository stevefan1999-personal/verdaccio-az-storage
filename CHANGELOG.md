# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-11-02

### Changed

- **Breaking:** the plugin implements the Verdaccio 7 promise storage API and requires Verdaccio 7 and Node.js 24 or later.
- Token records are kept in their own blob, `.verdaccio-tokens.json`, for both database providers.
- A missing package answers 404, and the cache header is `max-age`.

### Fixed

- A failed database read stops Verdaccio with an error instead of replacing the stored database with an empty one.
- Package metadata updates use the blob ETag, so a concurrent writer gets a conflict instead of a lost update.
- A `packagesDir` that leaves the container is refused, and an App Configuration database over 10 KB is refused before it is sent.

### Added

- Unit tests, the Verdaccio plugin verifier, and end-to-end tests with npm and pnpm against Verdaccio 7 and Azurite.

## [1.3.0] - 2025-07-15

### Changed

- Bump deps

### Fixed

- Fix package.json getting created for non-existent packages.

## [1.2.0] - 2025-01-28

### Added

- Added additional Azure authentication options (#2)

### Changed

- Updated deps

## [1.1.1] - 2024-09-19

### Fixed

- Fix plugin search method not working as expected

## [1.1.0] - 2024-08-09

### Fixed

- Fix up writeTarball not working for uplinked packages

### Changed

- Update writeTarball content type from 'application/x-compressed' to 'application/x-compressed-tar'
- Update deps
- Remove readTarball tarball_url_redirect workaround

## [1.0.1] - 2024-08-07

### Fixed

- Fixed search method

## [1.0.0] - 2024-08-07

### Added

- Initial release
