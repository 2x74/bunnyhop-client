# Security policy

This repository distributes early native client previews. Reports should identify
the release version, native build ID from its JSON report, operating system and
source revision. There is no established response-time commitment.

No verified private vulnerability-reporting channel has been established.
Arrange a private channel with a maintainer before sending sensitive details;
do not post tokens, cookies, exploit details or account data in public issues.
The package's noreply email is not a security inbox.

Relevant native-client issues include unsafe map/content parsing, memory safety,
web-menu bridge validation, navigation or authentication-origin escapes, replay
and cache path traversal, credential disclosure, and package identity failures.
The native client uses web technology for menus and accounts; gameplay, input,
rendering and simulation run outside the web view. Game score-verification
issues should be reported privately to the game's maintainers.

For reproduction, include the affected revision, steps, observed impact and a
minimal proof when safe. Remove personal data from logs and screenshots.

Native previews are unsigned on Windows and ad-hoc sealed on macOS; they are
not notarized releases. They do not have an automatic updater. Check download
hashes against the release's checksum files. See [release setup](docs/releases.md)
for packaging and validation. The legacy Electron implementation at the
repository root has separate sandbox, IPC and update-signing behavior.
