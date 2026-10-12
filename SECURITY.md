# Security policy

There are no published releases or established response-time commitments yet. Reports should identify the source revision and operating system.

No verified private vulnerability-reporting channel has been established. Arrange a private channel with the maintainer before sending details, and keep them out of public issues. The package's noreply email is not a verified security inbox. Once the intended repository exists and private vulnerability reporting is enabled, its advisory form can become the preferred route. A working private contact is required before public distribution.

Useful reports include renderer sandbox escapes, IPC sender-validation failures, unsafe navigation or downloads, local vault path escapes, credential disclosure, and update/signing bypasses. The Electron shell trusts only the game origins and its bundled settings page for their respective native operations. Discord access is local and presence-only.

For reproduction, include the affected revision, steps, observed impact, and a minimal proof when safe. Remove tokens, cookies, account details, and private screenshots. Game score-verification issues should be reported privately to the game's maintainers.

Development builds never check for updates. Signed release builds must pass the gates in [release setup](docs/releases.md); unsigned artifacts must remain labelled developer builds.
